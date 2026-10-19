/**
 * Bulk product importer.
 *
 * Reads .xlsx, .xls, and .csv files from buffer, normalizes headers,
 * applies strict row validation, and performs atomic multi-table
 * product upsert and warehouse inventory creation within a single
 * PostgreSQL ACID transaction.
 */
import * as xlsx from 'xlsx';
import { AppError } from '../../errors/AppError.js';
import { withTransaction } from '../../db/pool.js';

const HEADER_MAPPINGS = {
  sku: ['sku', 'product_sku', 'product sku', 'item_sku', 'item sku', 'code'],
  name: ['name', 'product_name', 'product name', 'item_name', 'item name', 'title'],
  category: ['category', 'product_category', 'product category', 'cat'],
  unit_price: ['unit_price', 'unit price', 'price', 'unitprice', 'rate'],
  reorder_level: ['reorder_level', 'reorder level', 'reorder', 'reorderlevel', 'min_stock', 'min stock', 'threshold'],
  quantity: ['quantity', 'qty', 'initial_stock', 'initial stock', 'stock'],
};

function resolveColumnIndices(headerRow) {
  const indices = {
    sku: -1,
    name: -1,
    category: -1,
    unit_price: -1,
    reorder_level: -1,
    quantity: -1,
  };

  headerRow.forEach((col, idx) => {
    const clean = String(col ?? '').trim().toLowerCase().replace(/[\r\n\t]+/g, ' ');
    for (const [field, aliases] of Object.entries(HEADER_MAPPINGS)) {
      if (indices[field] === -1 && aliases.includes(clean)) {
        indices[field] = idx;
      }
    }
  });

  return indices;
}

export function parseAndValidateProductsFile(fileBuffer, originalName = '') {
  const lowerName = originalName.toLowerCase();
  const validExts = ['.xlsx', '.xls', '.csv'];
  if (originalName && !validExts.some((ext) => lowerName.endsWith(ext))) {
    throw AppError.badRequest(
      'Invalid file format. Only .xlsx, .xls, and .csv files are supported.',
      'INVALID_FILE_TYPE',
    );
  }

  let workbook;
  try {
    workbook = xlsx.read(fileBuffer, { type: 'buffer' });
  } catch {
    throw AppError.badRequest(
      'Failed to parse file. The file may be corrupt or invalid.',
      'CORRUPTED_FILE',
    );
  }

  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) {
    throw AppError.badRequest('Uploaded workbook contains no sheets.', 'EMPTY_WORKBOOK');
  }

  const worksheet = workbook.Sheets[sheetName];
  const rawRows = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

  if (!rawRows || rawRows.length === 0) {
    throw AppError.badRequest('Uploaded file is completely empty.', 'EMPTY_FILE');
  }

  // Find first row with any non-empty cell as header
  let headerRowIndex = -1;
  for (let i = 0; i < rawRows.length; i++) {
    if (rawRows[i]?.some((cell) => String(cell ?? '').trim() !== '')) {
      headerRowIndex = i;
      break;
    }
  }

  if (headerRowIndex === -1) {
    throw AppError.badRequest('Uploaded file contains no headers or data.', 'EMPTY_FILE');
  }

  const headerRow = rawRows[headerRowIndex];
  const colIndices = resolveColumnIndices(headerRow);

  const missingColumns = [];
  if (colIndices.sku === -1) missingColumns.push('sku');
  if (colIndices.name === -1) missingColumns.push('name');
  if (colIndices.unit_price === -1) missingColumns.push('unit_price');

  if (missingColumns.length > 0) {
    throw AppError.badRequest(
      `Missing required column headers: ${missingColumns.join(', ')}. Required headers are: sku, name, unit_price. Optional: category, reorder_level, quantity.`,
      'MISSING_REQUIRED_COLUMNS',
      { missingColumns },
    );
  }

  const dataRows = rawRows.slice(headerRowIndex + 1);
  const nonEmptyRows = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const excelRowNumber = headerRowIndex + 2 + i;
    const isBlank = !row?.some((cell) => cell !== undefined && cell !== null && String(cell).trim() !== '');
    if (!isBlank) {
      nonEmptyRows.push({ row, excelRowNumber });
    }
  }

  if (nonEmptyRows.length === 0) {
    throw AppError.badRequest('Uploaded file contains headers but no data rows.', 'NO_DATA_ROWS');
  }

  if (nonEmptyRows.length > 5000) {
    throw AppError.badRequest(
      'Uploaded file exceeds the maximum limit of 5,000 product rows.',
      'ROW_LIMIT_EXCEEDED',
    );
  }

  const errors = [];
  const validRows = [];
  const seenSkusInFile = new Map();

  for (const { row, excelRowNumber } of nonEmptyRows) {
    const rawSku = String(row[colIndices.sku] ?? '').trim();
    const rawName = String(row[colIndices.name] ?? '').trim();
    const rawCategory = colIndices.category !== -1 ? String(row[colIndices.category] ?? '').trim() : '';
    const rawPrice = colIndices.unit_price !== -1 ? row[colIndices.unit_price] : '';
    const rawReorder = colIndices.reorder_level !== -1 ? row[colIndices.reorder_level] : '';
    const rawQuantity = colIndices.quantity !== -1 ? row[colIndices.quantity] : '';

    const rowErrors = [];

    // SKU validation
    if (!rawSku) {
      rowErrors.push('Missing mandatory SKU field');
    } else if (rawSku.length < 2 || rawSku.length > 50) {
      rowErrors.push('SKU must be between 2 and 50 characters');
    } else if (!/^[A-Za-z0-9._-]+$/.test(rawSku)) {
      rowErrors.push('SKU may only contain letters, digits, dot, underscore, and hyphen');
    } else {
      const upper = rawSku.toUpperCase();
      if (seenSkusInFile.has(upper)) {
        rowErrors.push(`Duplicate SKU "${rawSku}" in file (already defined in row ${seenSkusInFile.get(upper)})`);
      } else {
        seenSkusInFile.set(upper, excelRowNumber);
      }
    }

    // Name validation
    if (!rawName) {
      rowErrors.push('Missing mandatory name field');
    } else if (rawName.length < 2 || rawName.length > 150) {
      rowErrors.push('Product name must be between 2 and 150 characters');
    }

    // Category validation (optional)
    let category = null;
    if (rawCategory) {
      if (rawCategory.length > 100) {
        rowErrors.push('Category must not exceed 100 characters');
      } else {
        category = rawCategory;
      }
    }

    // Unit Price validation
    let unitPrice = null;
    const cleanPrice = String(rawPrice ?? '').trim().replace(/^\$/, '');
    if (cleanPrice === '') {
      rowErrors.push('Missing mandatory unit price field');
    } else {
      const numPrice = Number(cleanPrice);
      if (Number.isNaN(numPrice) || !Number.isFinite(numPrice) || numPrice < 0) {
        rowErrors.push('Unit price must be a valid non-negative number');
      } else if (numPrice > 99_999_999.99) {
        rowErrors.push('Unit price is out of range (max 99,999,999.99)');
      } else {
        const parts = cleanPrice.split('.');
        if (parts.length > 1 && parts[1].length > 2) {
          rowErrors.push('Unit price may have at most 2 decimal places');
        } else {
          unitPrice = numPrice.toFixed(2);
        }
      }
    }

    // Reorder Level validation (defaults to 10)
    let reorderLevel = 10;
    const cleanReorder = String(rawReorder ?? '').trim();
    if (cleanReorder !== '') {
      const numReorder = Number(cleanReorder);
      if (!Number.isInteger(numReorder) || numReorder < 0) {
        rowErrors.push('Reorder level must be a non-negative integer');
      } else if (numReorder > 1_000_000) {
        rowErrors.push('Reorder level is out of range (max 1,000,000)');
      } else {
        reorderLevel = numReorder;
      }
    }

    // Quantity validation (optional per row)
    let quantity;
    const cleanQuantity = String(rawQuantity ?? '').trim();
    if (cleanQuantity !== '') {
      const numQty = Number(cleanQuantity);
      if (!Number.isInteger(numQty) || numQty < 0) {
        rowErrors.push('Quantity must be a non-negative integer');
      } else if (numQty > 1_000_000) {
        rowErrors.push('Quantity exceeds 1,000,000');
      } else {
        quantity = numQty;
      }
    }

    if (rowErrors.length > 0) {
      errors.push({
        row: excelRowNumber,
        sku: rawSku || 'N/A',
        error: rowErrors.join('; '),
      });
    } else {
      validRows.push({
        rowNumber: excelRowNumber,
        sku: rawSku,
        upperSku: rawSku.toUpperCase(),
        name: rawName,
        category,
        unitPrice,
        reorderLevel,
        quantity,
      });
    }
  }

  return {
    totalProcessed: nonEmptyRows.length,
    validRows,
    errors,
  };
}

export async function bulkImportProducts({
  fileBuffer,
  fileName,
  warehouseId,
  initialStock = 0,
  actor,
}) {
  const { totalProcessed, validRows, errors } = parseAndValidateProductsFile(fileBuffer, fileName);

  let successCount = 0;
  let warehouseInfo = null;

  await withTransaction(async (db) => {
    // 1. Verify warehouse exists and is active
    const { rows: whRows } = await db.query(
      'SELECT id, code, name FROM warehouses WHERE id = $1 AND deleted_at IS NULL AND is_active',
      [warehouseId],
    );
    if (whRows.length === 0) {
      throw AppError.notFound('Target warehouse not found or is inactive', 'WAREHOUSE_NOT_FOUND');
    }
    warehouseInfo = whRows[0];

    // 2. Process each valid row atomically
    for (const row of validRows) {
      // Upsert product into products table
      const { rows: prodRows } = await db.query(
        `INSERT INTO products (sku, name, category, unit_price, reorder_level)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (upper(sku)) WHERE deleted_at IS NULL
         DO UPDATE SET
           name = EXCLUDED.name,
           unit_price = EXCLUDED.unit_price,
           category = COALESCE(EXCLUDED.category, products.category),
           reorder_level = EXCLUDED.reorder_level
         RETURNING id, sku`,
        [row.sku, row.name, row.category, row.unitPrice, row.reorderLevel],
      );

      const productId = prodRows[0].id;
      const qty = row.quantity !== undefined ? row.quantity : initialStock;

      // Upsert inventory for the warehouse
      await db.query(
        `INSERT INTO inventory (warehouse_id, product_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (warehouse_id, product_id)
         DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity`,
        [warehouseId, productId, qty],
      );

      // Record in ledger if stock is added
      if (qty > 0) {
        await db.query(
          `INSERT INTO inventory_transactions (warehouse_id, product_id, delta, reason, note, created_by)
           VALUES ($1, $2, $3, 'receipt', 'Bulk product import', $4)`,
          [warehouseId, productId, qty, actor?.id ?? null],
        );
      }

      successCount += 1;
    }
  });

  errors.sort((a, b) => a.row - b.row);

  return {
    totalProcessed,
    successCount,
    failedCount: totalProcessed - successCount,
    warehouse: warehouseInfo,
    initialStock,
    errors,
  };
}
