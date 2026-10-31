/**
 * Order bulk-import request validation.
 *
 * Reuses Zod primitives from the shared schemas and adds two surfaces that
 * cannot live in `orders.schemas.js`:
 *
 *   1. The mandatory header aliases for column-based imports (sku, product_name,
 *      unit_price, quantity, warehouse_id) so callers can type in any case- and
 *      spacing-insensitive header name.
 *   2. A per-row sanitisation guard: every text field must not contain null bytes,
 *      and every numeric field is coerced to a finite number rather than trusting
 *      the raw string. That runs before any line can even reach the repository.
 */
import { z } from 'zod';
import { positiveInt, safeTextWithNullGuard } from '../../lib/commonSchemas.js';

/**
 * Aliases allow the same import template to work across wildly different files:
 *   - Excel files exported by different systems ("SKU", "Product SKU", "SKU"),
 *   - CSV files generated with trailing spaces ("unit_price ", "unit_price").
 * Each alias is matched case-insensitively after a whitespace normaliser
 * (see `normalizeHeaders`).
 */
export const HEADER_ALIASES = {
  sku: ['sku', 'product_sku', 'product sku', 'item_sku', 'code'],
  product_name: ['product_name', 'product name', 'item_name', 'name'],
  unit_price: ['unit_price', 'unit price', 'price'],
  quantity: ['quantity', 'qty'],
  warehouse_id: ['warehouse_id', 'warehouse'],
  currency: ['currency', 'ccy', 'currency code'],
};

/**
 * A type accepted where a row value came from an untrusted spreadsheet cell:
 * it normalises whitespace (trim + collapse runs of internal whitespace),
 * enforces length bounds, and rejects null bytes.
 */
export const cellField = (options = {}) =>
  safeTextWithNullGuard(options.min ?? 1, options.max ?? 150);

/**
 * Like `cellField` but allows a missing value, treating absence as
 * "the column was not supplied on this row". Use for columns that are
 * optional per the business rules (e.g. currency).
 */
export const optionalCellField = (options = {}) =>
  safeTextWithNullGuard(options.min ?? 0, options.max ?? 5).optional();

/**
 * Parses the header row into field indices. Missing required columns are
 * reported as an error object to throw synchronously; unknown aliases are
 * ignored quietly.
 */
export function resolveHeaderIndices(headerRow) {
  const indices = { sku: -1, product_name: -1, unit_price: -1, quantity: -1, warehouse_id: -1, currency: -1 };

  headerRow.forEach((rawCol, idx) => {
    const clean = String(rawCol ?? '').trim().toLowerCase().replace(/[\r\n\t]+/g, ' ');
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (indices[field] === -1 && aliases.includes(clean)) {
        indices[field] = idx;
      }
    }
  });

  return indices;
}

/** Returns true if the named column was found among the file headers. */
export function hasColumn(indices, field) {
  return indices[field] !== -1;
}

/** Yields the raw header cell values by position for each named field. */
export function readCell(row, index) {
  if (index < 0 || index >= row.length) return undefined;
  return row[index];
}

/** Extracts a clean value from one cell, or undefined when blank. */
export function parseNumberOrUndefined(cell) {
  if (cell === undefined || cell === null) return undefined;
  const value = Number(cell);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Per-row schema used both by the validator path and the service path.
 * Keeping it inline lets a single Zod rule harden every call site at once
 * while still permitting the optional fields below.
 */
export const orderLineSchema = z
  .object({
    product_id: z.coerce.number().int().positive('product_id must be a positive integer'),
    quantity: z.coerce.number().int().positive('quantity must be a positive integer'),
    warehouse_id: z.coerce.number().int().positive('warehouse_id must be a positive integer').optional(),
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((v) => v.toUpperCase())
      .optional(),
  })
  .superRefine((value, ctx) => {
    // Reject anything NaN/Infinity that slipped through the coerce, and clamp
    // the upper bound at the configured ORDER_MAX_QUANTITY_PER_LINE so an
    // attacker cannot propose an arbitrarily large quantity before it hits the
    // database-level check anyway.
    if (!Number.isFinite(value.quantity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quantity'],
        message: 'quantity is not a finite number',
      });
    }
    if (!Number.isFinite(value.product_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['product_id'],
        message: 'product_id is not a finite number',
      });
    }
  });

export const bulkImportSchema = z.object({
  warehouse_id: z.number().int().positive('warehouse_id must be a positive integer').optional(),
  initial_stock: z.number().int().min(0).optional(),
});
