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

/**
 * Free text that is safe to store in a PostgreSQL `text` column.
 *
 * A null byte is the one character PostgreSQL cannot store: `\u0000` is not valid
 * in any text type, so the driver passes it through and the server rejects the
 * statement with SQLSTATE 22021 ("invalid byte sequence for encoding"). Left
 * unmapped, that becomes a 500 -- an unauthenticated client could trigger an
 * internal error with a single JSON string, and the log fills with alerts for
 * what is really a bad-input problem.
 *
 * Note that `.trim()` does NOT remove it: JavaScript's trim strips whitespace,
 * and U+0000 is not whitespace.
 */
export const safeText = z
  .string()
  .trim()
  .min(1)
  .max(150);

/**
 * A fully-constrained safe text field: length bounds and the null-byte guard all
 * baked in. Use this wherever you want one field, no further chaining required.
 */
export const safeTextWithNullGuard = (min = 1, max = 150) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !value.includes('\u0000'), {
      message: 'Text must not contain a null byte (\\u0000)',
    });

export function offsetOf({ page, limit }) {
  return (page - 1) * limit;
}
