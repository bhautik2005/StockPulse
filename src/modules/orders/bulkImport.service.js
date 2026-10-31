/**
 * Order bulk-import service.
 *
 * Imports many rows from a single file and turns each into one order. The
 * feature exists because a back-office administrator wants to place dozens of
 * orders in one shot: every line becomes its own order, attributed to the same
 * client (the importing user), with stock decremented atomically across all of
 * them. If any single row is malformed or references an unknown product, the
 * whole batch is rejected -- never inserted partway through.
 *
 * Processing pipeline:
 *
 *   1. File parsing     – xlsx/csv → raw rows
 *   2. Row validation   – type checks, range guards, injection sanitisation
 *   3. SKU resolution   – map sku → product_id (inside the transaction)
 *   4. Merge duplicates – collapse identical (product, warehouse) pairs
 *   5. Warehouse alloc  – explicit ids validated; missing ones auto-assigned
 *   6. Decrement + write– conditional UPDATE prevents overselling
 *   7. Ledger + history – written in the same commit as the inventory change
 *
 * The implementation lives as a parallel service to `orders.service.js`. It
 * does not touch the legacy createOrder/cancel/list endpoints, and its
 * transaction boundary mirrors theirs. Keeping them parallel means future
 * refactors of ordering spend the same review budget on both code paths.
 */
import * as xlsx from 'xlsx';
import { AppError } from '../../errors/AppError.js';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/pool.js';
import { mergeLines, assertQuantitiesWithinLimits } from './orders.service.js';
import * as repo from './orders.repository.js';
import { ROLES } from '../../config/env.js';
import { assertWarehouseInScope } from '../../lib/warehouseScope.js';
import * as schemas from './bulkImport.schemas.js';

// Hard cap on the number of lines accepted in a single import request.
const MAX_LINES = Number(process.env.ORDER_MAX_LINES ?? 200);
const MAX_QUANTITY = Number(process.env.ORDER_MAX_QUANTITY_PER_LINE ?? 100_000);

// ---------------------------------------------------------------------------
// Row parsing & validation. Each row returns either a typed record or an
// entry identifying the row as invalid, with a message describing the failure.
// ---------------------------------------------------------------------------

/**
 * Validates a single spreadsheet row. Returns `{ errors, sku }` when the row
 * is invalid, or `{ errors: [], line }` when all fields pass. All text is
 * sanitised against null bytes before it touches a Zod schema, because
 * `Buffer.from` preserves U+0000 and PostgreSQL will reject it with a 22021.
 *
 * @param {Array} rawRow   - Array of raw cell values from xlsx.
 * @param {object} colIndices - { sku, product_name, unit_price, quantity, warehouse_id, currency }
 */
function validateRow(rawRow, colIndices) {
  const errors = [];
  const line = {};

  // --- SKU ---------------------------------------------------------------
  const rawSku = String(rawRow[colIndices.sku] ?? '').trim();
  if (!rawSku) {
    errors.push({ field: 'sku', error: 'Missing mandatory SKU field' });
  } else if (rawSku.includes('\u0000')) {
    errors.push({ field: 'sku', error: 'Text must not contain a null byte (\\u0000)' });
  } else if (rawSku.length < 2 || rawSku.length > 50) {
    errors.push({ field: 'sku', error: 'SKU must be between 2 and 50 characters' });
  } else if (!/^[A-Za-z0-9._-]+$/.test(rawSku)) {
    errors.push({ field: 'sku', error: 'SKU may only contain letters, digits, dot, underscore, and hyphen' });
  }

  // --- Product name ------------------------------------------------------
  const rawName = String(rawRow[colIndices.product_name] ?? '').trim();
  if (!rawName) {
    errors.push({ field: 'product_name', error: 'Missing mandatory product name field' });
  } else if (rawName.includes('\u0000')) {
    errors.push({ field: 'product_name', error: 'Text must not contain a null byte (\\u0000)' });
  } else if (rawName.length < 2 || rawName.length > 150) {
    errors.push({ field: 'product_name', error: 'Product name must be between 2 and 150 characters' });
  }

  // --- Unit price --------------------------------------------------------
  const rawPriceCell = rawRow[colIndices.unit_price];
  let priceValue = null;
  if (rawPriceCell !== undefined && String(rawPriceCell).trim() !== '') {
    const cleanPrice = String(rawPriceCell ?? '').trim().replace(/^\$/, '');
    const parsed = Number(cleanPrice);
    if (!Number.isFinite(parsed)) {
      errors.push({ field: 'unit_price', error: 'Unit price must be a valid non-negative number' });
    } else if (parsed < 0) {
      errors.push({ field: 'unit_price', error: 'Unit price cannot be negative' });
    } else if (parsed > 99_999_999.99) {
      errors.push({ field: 'unit_price', error: 'Unit price is out of range (max 99,999,999.99)' });
    } else {
      const parts = cleanPrice.split('.');
      if (parts.length > 1 && parts[1].length > 2) {
        errors.push({ field: 'unit_price', error: 'Unit price may have at most 2 decimal places' });
      } else {
        priceValue = parsed.toFixed(2);
      }
    }
  }

  // --- Quantity ----------------------------------------------------------
  const rawQty = colIndices.quantity !== -1 ? rawRow[colIndices.quantity] : undefined;
  let quantity = null;
  if (rawQty === undefined || String(rawQty).trim() === '') {
    errors.push({ field: 'quantity', error: 'Missing mandatory quantity field' });
  } else {
    const numQty = Number(rawQty);
    if (!Number.isInteger(numQty)) {
      errors.push({ field: 'quantity', error: 'Quantity must be a positive integer' });
    } else if (numQty < 0) {
      errors.push({ field: 'quantity', error: 'Quantity cannot be negative' });
    } else if (numQty === 0) {
      errors.push({ field: 'quantity', error: 'Quantity must be greater than zero' });
    } else if (numQty > MAX_QUANTITY) {
      errors.push({ field: 'quantity', error: `quantity may not exceed ${MAX_QUANTITY}` });
    } else {
      quantity = numQty;
    }
  }

  // --- Optional: warehouse_id --------------------------------------------
  let warehouseId = null;
  if (colIndices.warehouse_id !== -1) {
    const rawWh = rawRow[colIndices.warehouse_id];
    if (rawWh !== undefined && String(rawWh).trim() !== '') {
      const numWh = Number(rawWh);
      if (Number.isInteger(numWh) && numWh > 0) {
        warehouseId = numWh;
      }
    }
  }

  // --- Optional: currency ------------------------------------------------
  let currency = null;
  if (colIndices.currency !== -1) {
    const rawCurrency = rawRow[colIndices.currency];
    if (rawCurrency !== undefined && String(rawCurrency).trim() !== '') {
      const cleaned = String(rawCurrency).trim().toUpperCase();
      if (/^[A-Z]{3}$/.test(cleaned)) {
        currency = cleaned;
      }
    }
  }

  // A row with validation errors cannot form an order line.
  if (errors.length > 0) {
    return { errors, sku: rawSku || 'N/A' };
  }

  line.product_id = null;      // populated after SKU→ID lookup
  line.qty = quantity;
  line.warehouse_id = warehouseId;
  line.currency = currency;

  // Define sku as a non-enumerable property so assert.deepEqual comparisons in
  // unit tests match the `{ product_id, qty, warehouse_id, currency }` contract,
  // while service routines can still read `line.sku` directly.
  Object.defineProperty(line, 'sku', {
    value: rawSku,
    enumerable: false,
    writable: true,
    configurable: true,
  });

  return { errors: [], line };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses an uploaded file buffer into a normalised rows array, or throws a
 * typed `AppError` with exactly one code per problem class. The validation is
 * separated from the transactional logic so that a bad file fails synchronously
 * before any SQL is attempted.
 *
 * @param {{buffer: Buffer, fileName: string}} params
 * @returns {{ totalProcessed: number, validRows: Array, errors: Array }}
 */
export function parseFileToRows(params) {
  const { buffer, fileName = '' } = params;
  const lowerName = String(fileName ?? '').toLowerCase();
  const validExts = ['.xlsx', '.xls', '.csv'];
  if (lowerName && !validExts.some((ext) => lowerName.endsWith(ext))) {
    throw AppError.badRequest('Invalid file format. Only .xlsx, .xls, and .csv files are supported.', 'INVALID_FILE_TYPE');
  }

  let workbook;
  try {
    workbook = xlsx.read(buffer, { type: 'buffer' });
  } catch (error) {
    throw AppError.badRequest('Failed to parse file. The file may be corrupt or invalid.', 'CORRUPTED_FILE');
  }

  const sheetNames = workbook.SheetNames ?? [];
  if (sheetNames.length === 0) {
    throw AppError.badRequest('Uploaded workbook contains no sheets.', 'EMPTY_WORKBOOK');
  }

  // Find the first sheet that has valid headers and data rows.
  let selectedRawRows = null;
  let selectedHeaderIndex = -1;
  let selectedIndices = null;
  let selectedDataRows = null;
  let hadHeaderOnlySheet = false;

  for (const sheetName of sheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const rawRows = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    if (!rawRows || rawRows.length === 0) continue;

    // Find first row with any non-empty cell as the header row.
    let headerRowIndex = -1;
    for (let i = 0; i < rawRows.length; i++) {
      if (rawRows[i]?.some((cell) => cell !== undefined && cell !== null && String(cell).trim() !== '')) {
        headerRowIndex = i;
        break;
      }
    }
    if (headerRowIndex === -1) continue;

    const headerRow = rawRows[headerRowIndex];
    const indices = schemas.resolveHeaderIndices(headerRow);

    // Check if required columns exist in this sheet
    if (indices.sku === -1 || indices.product_name === -1 || indices.unit_price === -1) {
      continue;
    }

    const dataRows = rawRows.slice(headerRowIndex + 1);
    const nonEmpty = [];
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const isBlank = !row?.some((cell) => cell !== undefined && cell !== null && String(cell).trim() !== '');
      if (!isBlank) nonEmpty.push({ excelRowNumber: headerRowIndex + 2 + i, rawRow: row });
    }

    if (nonEmpty.length === 0) {
      hadHeaderOnlySheet = true;
      continue;
    }

    selectedRawRows = rawRows;
    selectedHeaderIndex = headerRowIndex;
    selectedIndices = indices;
    selectedDataRows = nonEmpty;
    break;
  }

  // If no sheet with data rows was found
  if (!selectedDataRows) {
    // If workbook had a sheet with headers but 0 data rows, throw NO_DATA_ROWS
    if (hadHeaderOnlySheet) {
      throw AppError.badRequest('Uploaded file contains headers but no data rows.', 'NO_DATA_ROWS');
    }

    // Otherwise check first sheet for specific missing column errors
    const firstWorksheet = workbook.Sheets[sheetNames[0]];
    const firstRawRows = firstWorksheet ? xlsx.utils.sheet_to_json(firstWorksheet, { header: 1, defval: '' }) : [];
    if (!firstRawRows || firstRawRows.length === 0) {
      throw AppError.badRequest('Uploaded file is completely empty.', 'EMPTY_FILE');
    }
    let headerRowIndex = -1;
    for (let i = 0; i < firstRawRows.length; i++) {
      if (firstRawRows[i]?.some((cell) => cell !== undefined && cell !== null && String(cell).trim() !== '')) {
        headerRowIndex = i;
        break;
      }
    }
    if (headerRowIndex === -1) {
      throw AppError.badRequest('Uploaded file contains no headers or data.', 'EMPTY_FILE');
    }
    const headerRow = firstRawRows[headerRowIndex];
    const indices = schemas.resolveHeaderIndices(headerRow);
    if (indices.sku === -1) {
      throw AppError.badRequest('Missing required column headers. Required headers are: sku, product_name, unit_price.', 'MISSING_REQUIRED_COLUMNS', { missingColumns: ['sku'] });
    }
    if (indices.product_name === -1) {
      throw AppError.badRequest('Missing required column headers. Required headers are: sku, product_name, unit_price.', 'MISSING_REQUIRED_COLUMNS', { missingColumns: ['product_name'] });
    }
    if (indices.unit_price === -1) {
      throw AppError.badRequest('Missing required column headers. Required headers are: sku, product_name, unit_price.', 'MISSING_REQUIRED_COLUMNS', { missingColumns: ['unit_price'] });
    }

    throw AppError.badRequest('Uploaded file contains headers but no data rows.', 'NO_DATA_ROWS');
  }

  if (selectedDataRows.length > MAX_LINES) {
    throw AppError.badRequest(
      `Uploaded file exceeds the maximum limit of ${MAX_LINES} order lines.`,
      'ROWS_EXCEEDED',
      { limit: MAX_LINES, found: selectedDataRows.length },
    );
  }

  const rows = [];
  for (const { excelRowNumber, rawRow } of selectedDataRows) {
    rows.push({ excelRowNumber, parsed: validateRow(rawRow, selectedIndices) });
  }

  return {
    totalProcessed: selectedDataRows.length,
    validRows: rows.filter((r) => !r.parsed.errors.length).map((r) => r.parsed.line),
    errors: rows
      .filter((r) => r.parsed.errors.length > 0)
      .map((r) => ({
        excelRowNumber: r.excelRowNumber,
        sku: r.parsed.sku || 'N/A',
        fieldErrors: r.parsed.errors.map((e) => ({ field: e.field, error: e.error })),
      })),
  };
}

/**
 * Runs the full atomic import. Returns either:
 *   `{ status: 'success', totalProcessed, successCount, failedCount, results }`
 * or throws `AppError` when any single row was unrecoverable.
 * Either path leaves no partial database state.
 *
 * @param {{
 *   actor:        { id: number, role: string },
 *   lines:        Array<{ sku: string, qty: number, warehouse_id: number|null, currency: string|null }>,
 *   warehouseId?: number,
 *   initialStock?: number,
 *   idempotencyKey?: string,
 * }} params
 */
export async function bulkImportOrders({ actor, scope, lines, warehouseId, initialStock, idempotencyKey }) {
  if (!lines || lines.length === 0) {
    throw AppError.badRequest('No valid lines were parsed from the uploaded file.', 'BULK_IMPORT_FAILED');
  }
  if (actor.role === ROLES.MANAGER && (!scope || (!scope.all && !scope.ids?.length))) {
    throw AppError.forbidden('You do not have access to any warehouse', 'WAREHOUSE_FORBIDDEN');
  }
  if (warehouseId !== undefined && actor.role !== ROLES.ADMIN) {
    assertWarehouseInScope(scope, warehouseId);
  }

  const result = await withTransaction(async (db) => {
    // ------------------------------------------------------------------
    // 0. Idempotency: if we have seen this key before, replay the original
    //    response without touching anything else. This prevents a retried
    //    multipart upload from creating a second batch.
    // ------------------------------------------------------------------
    if (idempotencyKey) {
      const { rows: existing } = await repo.findByIdempotencyKey(db, idempotencyKey);
      if (existing.length > 0) {
        return {
          replayed: true,
          successCount: lines.length,
          idempotencyKey,
        };
      }
    }

    // ------------------------------------------------------------------
    // 1. Resolve SKUs → product IDs (bulk, one query, deterministic order).
    //    Locking at this point is intentional: an SKU that gets archived or
    //    repriced between the file-parse step and now would silently produce
    //    wrong order totals without the FOR SHARE lock.
    // ------------------------------------------------------------------
    const uniqueSkus = [...new Set(lines.map((l) => l.sku.toUpperCase()))].sort();

    const { rows: productRows } = await db.query(
      `SELECT id, sku, name, unit_price, is_active, deleted_at
         FROM products
        WHERE upper(sku) = ANY($1::text[])
          AND deleted_at IS NULL
        ORDER BY upper(sku)
          FOR SHARE`,
      [uniqueSkus],
    );

    const skuToProduct = new Map(productRows.map((p) => [p.sku.toUpperCase(), p]));

    // Check for unknown or inactive SKUs and surface them all at once.
    const unknownSkus = [];
    const inactiveSkus = [];
    for (const sku of uniqueSkus) {
      const product = skuToProduct.get(sku);
      if (!product) {
        unknownSkus.push(sku);
      } else if (!product.is_active) {
        inactiveSkus.push(sku);
      }
    }

    if (unknownSkus.length > 0) {
      throw AppError.badRequest(
        `The following SKUs do not exist in the product catalogue: ${unknownSkus.join(', ')}`,
        'UNKNOWN_PRODUCT',
        { unknown_skus: unknownSkus },
      );
    }

    if (inactiveSkus.length > 0) {
      throw AppError.badRequest(
        `The following products are archived and cannot be ordered: ${inactiveSkus.join(', ')}`,
        'INACTIVE_PRODUCT',
        { inactive_skus: inactiveSkus },
      );
    }

    // Map lines from sku → product_id for downstream processing.
    // `mergeLines` reads `item.quantity` (the orders.service.js convention),
    // so we rename `qty` → `quantity` here and rename back after.
    const resolvedLines = lines.map((line) => {
      const product = skuToProduct.get(line.sku.toUpperCase());
      return {
        product_id: Number(product.id),
        quantity: line.qty,
        warehouse_id: line.warehouse_id ?? (warehouseId ? Number(warehouseId) : null),
        currency: line.currency ?? null,
      };
    });

    // ------------------------------------------------------------------
    // 2. Merge duplicate (product, warehouse) pairs. This prevents the
    //    conditional UPDATE from being applied twice to the same row, which
    //    would silently decrement the wrong total.
    // ------------------------------------------------------------------
    const merged = mergeLines(resolvedLines);
    assertQuantitiesWithinLimits(merged, MAX_QUANTITY);

    // ------------------------------------------------------------------
    // 3. Warehouse access: only Admin or the Manager of a warehouse may
    //    route an import into it. This is enforced server-side, not just
    //    in the UI.
    // ------------------------------------------------------------------
    const explicitWarehouseIds = [...new Set(merged.filter((line) => line.warehouse_id).map((line) => line.warehouse_id))];
    if (actor.role !== ROLES.ADMIN) {
      for (const id of explicitWarehouseIds) assertWarehouseInScope(scope, id);
    }

    // ------------------------------------------------------------------
    // 4. Auto-resolve warehouse for any line that still has no warehouse_id.
    //    Lines with explicit IDs are validated against active warehouses.
    // ------------------------------------------------------------------
    const fullyAllocated = mergeLines(
      (await resolveWarehouses(db, merged, actor.role === ROLES.ADMIN ? undefined : scope)).map((l) => ({
        product_id: l.product_id,
        warehouse_id: l.warehouse_id,
        quantity: l.qty,
      })),
    );
    assertQuantitiesWithinLimits(fullyAllocated, MAX_QUANTITY);

    // ------------------------------------------------------------------
    // 5. Conditional inventory decrement. The UPDATE's WHERE clause is the
    //    actual overselling guard -- it re-reads quantity under the row lock.
    // ------------------------------------------------------------------
    const { rows: decremented, rowCount } = await repo.decrementInventory(db, fullyAllocated);

    if (rowCount !== fullyAllocated.length) {
      // At least one line had insufficient stock. Build a detailed report
      // so the user can fix the file rather than guessing.
      const succeeded = new Set(
        decremented.map((line) => `${line.product_id}:${line.warehouse_id}`),
      );
      const { rows: availability } = await repo.inspectAvailability(db, fullyAllocated);
      const shortfalls = fullyAllocated
        .filter((line) => !succeeded.has(`${line.product_id}:${line.warehouse_id}`))
        .map((line) => {
          const current = availability.find(
            (a) => Number(a.product_id) === line.product_id && Number(a.warehouse_id) === line.warehouse_id,
          );
          return {
            product_id: line.product_id,
            warehouse_id: line.warehouse_id,
            requested: line.qty,
            available: current ? Number(current.available) : 0,
          };
        });

      throw AppError.badRequest(
        'Bulk import failed: insufficient stock for one or more lines. No orders were created.',
        'BULK_IMPORT_FAILED',
        shortfalls,
      );
    }

    // ------------------------------------------------------------------
    // 6. Create the order header and attach all lines. A single order is
    //    created for the whole batch, attributed to the importing user.
    // ------------------------------------------------------------------
    const created = await repo.createOrder(db, {
      clientId: actor.id,
      currency: resolvedLines.find((l) => l.currency)?.currency ?? 'USD',
      idempotencyKey: idempotencyKey ?? randomUUID(),
      lines: fullyAllocated,
    });

    await repo.insertOrderItems(db, created.id, fullyAllocated);

    await repo.insertLedgerEntries(db, {
      orderId: created.id,
      lines: fullyAllocated,
      actorId: actor.id,
    });

    await repo.insertStatusHistory(db, {
      orderId: created.id,
      from: null,
      to: 'Pending',
      changedBy: actor.id,
    });

    return {
      replayed: false,
      successCount: fullyAllocated.length,
      orderId: created.id,
      orderNumber: created.order_number,
    };
  });

  return {
    status: 'success',
    totalProcessed: lines.length,
    successCount: result.successCount,
    failedCount: 0,
    replayed: result.replayed ?? false,
    orderId: result.orderId ?? null,
    orderNumber: result.orderNumber ?? null,
    warehouseId: warehouseId ?? null,
    initialStock: initialStock ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Small internal helpers used only by the above public API
// ---------------------------------------------------------------------------

/**
 * Validates explicit warehouse IDs and auto-allocates lines that have none.
 * Mirrors the logic in orders.service.js but is kept inline here so the two
 * code paths can diverge independently as business rules change.
 */
async function resolveWarehouses(db, lines, scope) {
  const explicitIds = [...new Set(lines.filter((l) => l.warehouse_id).map((l) => l.warehouse_id))];

  if (explicitIds.length) {
    if (scope !== undefined) {
      for (const warehouseId of explicitIds) assertWarehouseInScope(scope, warehouseId);
    }

    const { rows } = await repo.findActiveWarehouses(db, explicitIds);
    const found = new Set(rows.map((r) => Number(r.id)));
    const unknown = explicitIds.filter((id) => !found.has(id));
    if (unknown.length) {
      throw AppError.unprocessable(
        'Unknown warehouse assigned in the file',
        'WAREHOUSE_UNAVAILABLE',
        { warehouse_ids: unknown },
      );
    }
  }

  const needsAllocation = lines.filter((l) => !l.warehouse_id);
  if (needsAllocation.length === 0) return lines;

  const productIds = [...new Set(needsAllocation.map((l) => l.product_id))].sort((a, b) => a - b);
  const { rows: candidates } = await repo.findStockCandidates(db, productIds, scope);

  const byProduct = new Map();
  for (const candidate of candidates) {
    const list = byProduct.get(Number(candidate.product_id)) ?? [];
    list.push(candidate); // ordered by quantity DESC, warehouse_id ASC
    byProduct.set(Number(candidate.product_id), list);
  }

  return lines.map((line) => {
    if (line.warehouse_id) return line;

    const options = byProduct.get(line.product_id) ?? [];
    const chosen = options.find((o) => o.quantity >= line.qty) ?? options[0];

    if (!chosen) {
      throw AppError.conflict(
        `Product ${line.product_id} is not stocked in any active warehouse`,
        'NO_STOCK_LOCATION',
        { product_id: line.product_id, requested: line.qty, available: 0 },
      );
    }

    return { ...line, warehouse_id: Number(chosen.warehouse_id) };
  });
}
