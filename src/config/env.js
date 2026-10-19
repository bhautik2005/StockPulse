/**
 * Environment configuration.
 *
 * Fails fast: a service that boots with a missing JWT_SECRET or an unreachable
 * DATABASE_URL is worse than one that refuses to start, because the failure
 * surfaces later as a confusing 500 under load.
 */
import 'dotenv/config';
import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_POOL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL: z.string().default('15m'),
  COOKIE_NAME: z.string().default('sp_token'),
  CSRF_COOKIE_NAME: z.string().default('sp_csrf'),
  COOKIE_SECURE: booleanish.default(false),
  // Deliberately permissive at parse time: the real floor (>= 10) is enforced
  // by the refinement below, which exempts the test suite. bcrypt is meant to be
  // slow, and a fast cost factor in production is a silent weakening of every
  // stored password.
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  ORDER_MAX_LINES: z.coerce.number().int().positive().max(1000).default(200),
  ORDER_MAX_QUANTITY_PER_LINE: z.coerce.number().int().positive().default(100_000),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV !== 'test' && value.BCRYPT_ROUNDS < 10) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BCRYPT_ROUNDS'],
      message: 'BCRYPT_ROUNDS must be at least 10 outside the test environment',
    });
  }
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Intentional: no logger here, this runs before the logger exists.
  console.error(`Invalid environment configuration:\n${details}\n\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

export const env = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
});

/** Roles recognised by the system. Kept in one place to avoid string drift. */
export const ROLES = Object.freeze({
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  STAFF: 'Staff',
  CLIENT: 'Client',
});

/** Roles that operate *inside* a warehouse and are therefore scope-limited. */
export const WAREHOUSE_SCOPED_ROLES = Object.freeze([ROLES.MANAGER, ROLES.STAFF]);