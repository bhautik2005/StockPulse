/**
 * Phase 1 :: Global setup.
 *
 * Vitest runs this once, in its own module context, before any test file is
 * loaded. It must therefore be self-sufficient: set the environment, make a
 * database available, and build the schema -- all before src/config/env.js is
 * imported by a worker, because that module freezes process.env at import time.
 *
 * Deliberately NOT here: stopping the database. Stopping a cluster the operator
 * may be using interactively would be surprising, and CI runners are discarded
 * anyway. `npm run db:down` is the explicit way to stop it.
 */
export default async function globalSetup() {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
  process.env.JWT_SECRET ??= 'qa-suite-only-jwt-secret-abcdefghijklmnopqrstuvwxyz-0123456789';
  process.env.COOKIE_SECURE ??= 'false';
  process.env.BCRYPT_ROUNDS ??= '4';

  const { prepareDatabase, redact } = await import('./prepare-database.js');
  const { source, url } = await prepareDatabase();

  // Make it unmistakable when the suite is about to rebuild a *remote* database
  // (a disposable Supabase project in CI) rather than the local cluster.
  if (source === 'env') console.log(`\n[qa-suite] schema will be rebuilt on ${redact(url)}\n`);

  const { migrate } = await import('../../../src/db/migrate.js');
  const { closePool } = await import('../../../src/db/pool.js');

  try {
    await migrate({ fresh: true });
  } finally {
    await closePool();
  }
}
