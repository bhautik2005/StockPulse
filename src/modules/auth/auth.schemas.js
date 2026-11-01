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

/**
 * Password reset.
 *
 * The token is shape-checked only as "a short non-empty string" here. Whether
 * it is one of *our* tokens is decided in the service, so a malformed link
 * produces the same { valid: false } the UI already handles instead of a 400
 * the caller would have to special-case.
 */
const resetToken = z.string().trim().min(1, 'A reset token is required').max(200);

export const forgotPasswordSchema = z.object({ email });

export const validateResetTokenSchema = z.object({ token: resetToken });

export const resetPasswordSchema = z
  .object({
    token: resetToken,
    password,
    confirmPassword: z.string().min(1, 'Confirm your new password').max(72),
  })
  // Reported against the confirmation field, which is where a user looks for it.
  .refine((value) => value.password === value.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const listUsersQuery = paginationQuery;