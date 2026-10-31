import { z } from 'zod';
import { safeText, paginationQuery, safeTextWithNullGuard } from '../../lib/commonSchemas.js';

/**
 * Prices arrive as numbers or strings and are normalised to a decimal string.
 *
 * The refinement rejects sub-cent precision outright rather than letting the
 * database round it: a price of 19.999 silently becoming 20.00 is a bug nobody
 * notices until an invoice disagrees with the catalogue.
 */
const price = z
  .union([z.number(), z.string().regex(/^\d+(\.\d{1,2})?$/, 'Use a decimal with at most 2 places')])
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .refine((v) => Number.isFinite(v) && v >= 0, 'Price must be zero or greater')
  .refine((v) => Number.isInteger(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
    message: 'Price may have at most 2 decimal places',
  })
  .refine((v) => v <= 99_999_999.99, 'Price is out of range')
  .transform((v) => v.toFixed(2)); // exact decimal string for the NUMERIC column

export const createProductSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[A-Za-z0-9._-]+$/, 'SKU may contain letters, digits, dot, underscore and hyphen'),
  name: safeTextWithNullGuard(2, 150),
  category: safeTextWithNullGuard(1, 100).optional(),
  unit_price: price,
  reorder_level: z.coerce.number().int().min(0).max(1_000_000).default(10),
});

export const updateProductSchema = z
  .object({
    name: safeTextWithNullGuard(2, 150).optional(),
    category: safeTextWithNullGuard(1, 100).nullable().optional(),
    unit_price: price.optional(),
    reorder_level: z.coerce.number().int().min(0).max(1_000_000).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export const listProductsQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  include_inactive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const catalogQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().min(1).max(100).optional(),
});
