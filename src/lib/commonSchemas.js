/**
 * Shared Zod building blocks.
 */
import { z } from 'zod';

/** Accepts "12" or 12 and yields a positive integer. */
export const positiveInt = z.coerce.number().int().positive();

export const idParam = z.object({ id: positiveInt });

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Hard ceiling: an unbounded `limit` is a denial-of-service vector.
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const uuidString = z.string().uuid();

export function offsetOf({ page, limit }) {
  return (page - 1) * limit;
}