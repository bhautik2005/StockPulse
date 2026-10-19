import { z } from 'zod';
import { paginationQuery, positiveInt } from '../../lib/commonSchemas.js';

export const listInventoryQuery = paginationQuery.extend({
  warehouse_id: positiveInt.optional(),
  product_id: positiveInt.optional(),
  low_stock: z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

/**
 * A stock adjustment.
 *
 * `delta` is signed and may not be zero: a zero adjustment is either a mistake
 * or an attempt to create a no-op ledger entry. The absolute ceiling keeps a
 * typo such as 1000000000 from silently inventing inventory.
 */
export const adjustStockSchema = z.object({
  warehouse_id: positiveInt,
  product_id: positiveInt,
  delta: z.coerce
    .number()
    .int()
    .refine((v) => v !== 0, 'delta must not be zero')
    .refine((v) => Math.abs(v) <= 1_000_000, 'delta must be within +/-1,000,000'),
  note: z.string().trim().max(500).optional(),
});