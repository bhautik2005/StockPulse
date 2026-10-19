/**
 * Order request validation.
 *
 * Boundary rules enforced here, before a single SQL statement runs:
 *   - at least one line, at most ORDER_MAX_LINES
 *   - quantity is a positive integer with a sane upper bound
 *   - `total_amount` is deliberately *absent*: the client cannot propose a price
 */
import { z } from 'zod';
import { env } from '../../config/env.js';
import { paginationQuery, positiveInt, uuidString } from '../../lib/commonSchemas.js';

export const orderLineSchema = z.object({
  product_id: positiveInt,
  quantity: positiveInt.max(
    env.ORDER_MAX_QUANTITY_PER_LINE,
    `quantity may not exceed ${env.ORDER_MAX_QUANTITY_PER_LINE}`,
  ),
  // Optional: when omitted the service allocates the line to the warehouse
  // holding the most stock for that product.
  warehouse_id: positiveInt.optional(),
});

export const createOrderSchema = z.object({
  items: z
    .array(orderLineSchema)
    .min(1, 'An order must contain at least one line')
    .max(env.ORDER_MAX_LINES, `An order may not exceed ${env.ORDER_MAX_LINES} lines`),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((v) => v.toUpperCase())
    .optional(),
  // Accepted here for convenience; the Idempotency-Key header wins if present.
  idempotency_key: uuidString.optional(),
});

export const listOrdersQuery = paginationQuery.extend({
  status: z
    .enum(['Pending', 'Processing', 'Partially Shipped', 'Shipped', 'Delivered', 'Cancelled'])
    .optional(),
  client_id: positiveInt.optional(),
  warehouse_id: positiveInt.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const updateStatusSchema = z.object({
  status: z.enum(['Pending', 'Processing', 'Partially Shipped', 'Shipped', 'Delivered', 'Cancelled']),
  reason: z.string().trim().min(3).max(500).optional(),
});

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(3, 'A cancellation reason is required').max(500),
});

export const idempotencyKeyHeaderSchema = z.object({}).passthrough();