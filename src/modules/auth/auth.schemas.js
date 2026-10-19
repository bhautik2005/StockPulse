import { z } from 'zod';
import { ROLES } from '../../config/env.js';
import { paginationQuery, positiveInt } from '../../lib/commonSchemas.js';

const email = z
  .string()
  .trim()
  .min(3)
  .max(150)
  .email('A valid email address is required')
  .transform((v) => v.toLowerCase());

/**
 * bcrypt only considers the first 72 bytes of a password. Allowing longer input
 * would mean two different passwords hashing identically, so the limit is
 * enforced here rather than left as a silent truncation.
 */
const password = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(72, 'Password must be at most 72 characters (bcrypt limit)');

const name = z.string().trim().min(2).max(100);

/** Self-service registration. Always creates a Client -- see auth.service.js. */
export const registerSchema = z.object({ name, email, password });

export const loginSchema = z.object({ email, password: z.string().min(1).max(72) });

export const createUserSchema = z.object({
  name,
  email,
  password,
  role: z.enum([ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF, ROLES.CLIENT]).default(ROLES.STAFF),
  warehouse_ids: z.array(positiveInt).max(50).optional(),
});

export const updateUserSchema = z
  .object({
    name: name.optional(),
    role: z.enum([ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF, ROLES.CLIENT]).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export const warehouseAccessSchema = z.object({
  grant: z.array(positiveInt).max(50).default([]),
  revoke: z.array(positiveInt).max(50).default([]),
});

export const listUsersQuery = paginationQuery;