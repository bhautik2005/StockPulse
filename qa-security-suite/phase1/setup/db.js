/**
 * Phase 1 :: Test harness.
 *
 * Responsibilities, in strict order:
 *
 *   1. Pin the environment BEFORE any application module is imported, because
 *      src/config/env.js validates and freezes configuration at import time.
 *   2. Own the database. The suite must never inherit a developer's
 *      DATABASE_URL: `resetDatabase()` drops and rebuilds the schema, so
 *      pointing this at .env would wipe a seeded development or Supabase
 *      database on every run.
 *   3. Expose the Express app itself (Supertest drives it in-process; no port
 *      is opened, so there is nothing to race or forget to close).
 *   4. Give every test file a known-empty database and helpers to assert on SQL.
 *
 * Why dynamic imports: `src/config/env.js` freezes process.env at import time,
 * so a static `import { env }` would be hoisted above the assignments below and
 * read the wrong configuration.
 *
 * `expect` is imported explicitly rather than relied on as a global, so the
 * harness works with or without `globals: true` in the runner configuration.
 */
import { expect } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.JWT_SECRET ??= 'qa-suite-only-jwt-secret-abcdefghijklmnopqrstuvwxyz-0123456789';
process.env.COOKIE_SECURE ??= 'false';
process.env.BCRYPT_ROUNDS ??= '4';
process.env.DB_POOL_MAX ??= '16';

/*
 * The suite owns its database.
 *
 *   TEST_DATABASE_URL set  -> use it (CI, a disposable Supabase project, Docker)
 *   otherwise              -> the bundled embedded PostgreSQL cluster
 *
 * CRITICAL: the production DATABASE_URL from .env is *deliberately discarded*
 * here. `resetDatabase()` drops the schema, so inheriting .env would wipe a live
 * Supabase database. See ./prepare-database.js for the full resolution order.
 */
const { prepareDatabase } = await import('./prepare-database.js');
const database = await prepareDatabase({ quiet: process.env.TEST_LOG_LEVEL !== 'debug' });
process.env.DATABASE_URL = database.url;

const { migrate } = await import('../../../src/db/migrate.js');
const { createApp } = await import('../../../src/app.js');
const { pool, query, closePool } = await import('../../../src/db/pool.js');
const { env, ROLES } = await import('../../../src/config/env.js');
const { hashPassword } = await import('../../../src/lib/password.js');

export { pool, query, closePool, env, ROLES };

/** The Express application under test. `createApp()` is cheap and stateless. */
export const app = createApp();

/**
 * Drops and rebuilds the whole schema.
 *
 * Called once per test file. `migrate({ fresh: true })` is guarded against
 * NODE_ENV=production in src/db/migrate.js, so this can never be pointed at a
 * live environment even by accident.
 */
export async function resetDatabase() {
  await migrate({ fresh: true });
}

/**
 * Empties every application table without touching the schema.
 *
 * Cheaper than a full rebuild when a single test needs to start from nothing.
 * `TRUNCATE ... CASCADE` also resets identity sequences, so ids start at 1 and a
 * test can reason about them instead of pattern-matching.
 */
export async function truncateAll() {
  const { rows } = await query(`
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename <> 'schema_migrations'
  `);

  if (rows.length === 0) return;
  const list = rows.map((row) => `"public"."${row.tablename}"`).join(', ');
  await query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** First column of the first row, or undefined. */
export async function scalar(sql, params = []) {
  const { rows } = await query(sql, params);
  const first = rows[0];
  return first ? Object.values(first)[0] : undefined;
}

/** All rows of a query, for assertions that need more than one value. */
export async function rows(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

/**
 * Creates the very first administrator directly in the database.
 *
 * This is the one place in the system where an account is created without an
 * Admin's authority -- which is exactly why it lives in a bootstrap script
 * rather than behind an HTTP route. Everything else in the fixtures is created
 * through the real API so a fixture failure signals real breakage.
 */
export async function bootstrapAdmin({ email = 'root@stockpulse.test', password = 'AdminPass1234' } = {}) {
  const passwordHash = await hashPassword(password);
  const { rows: inserted } = await query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'Admin')
     RETURNING id, name, email, role`,
    ['Root Admin', email, passwordHash],
  );
  return { ...inserted[0], password };
}

/**
 * Asserts that raw SQL is refused by PostgreSQL, with a specific SQLSTATE.
 *
 * `sqlStates` accepts an array because PostgreSQL distinguishes
 * foreign_key_violation (23503) from restrict_violation (23001) depending on how
 * the reference was declared -- and ON DELETE RESTRICT raises 23001, which is the
 * distinction most test suites get wrong and therefore never actually prove.
 */
export async function expectSqlError(sql, params, sqlStates, constraintPattern) {
  const expected = (Array.isArray(sqlStates) ? sqlStates : [sqlStates]).map(String);

  await expect(query(sql, params)).rejects.toMatchObject({
    code: expect.stringMatching(new RegExp(`^(${expected.join('|')})$`)),
  });

  // Second pass: capture the constraint name so a caller can assert *which*
  // rule fired, not merely that something failed.
  if (constraintPattern) {
    let captured;
    try {
      await query(sql, params);
    } catch (error) {
      captured = error;
    }
    const target = `${captured?.constraint ?? ''} ${captured?.column ?? ''}`;
    expect(target).toMatch(constraintPattern);
  }
}

/** Runs `fn` for each index, concurrently. Used by the oversell race tests. */
export function concurrently(count, fn) {
  return Promise.all(Array.from({ length: count }, (_, index) => fn(index)));
}
