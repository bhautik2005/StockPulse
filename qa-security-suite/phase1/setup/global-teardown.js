/**
 * Phase 1 :: Global teardown.
 *
 * Closes the pool the setup phase opened. The embedded PostgreSQL *server* is
 * left running on purpose: stopping it would also stop the cluster a developer
 * may be using interactively (`npm run db:down` is the explicit way to do that),
 * and on CI the runner is destroyed anyway.
 */
export default async function globalTeardown() {
  process.env.NODE_ENV = 'test';

  // The pool module may never have been loaded (e.g. globalSetup failed early),
  // so a failure to import is not itself a failure.
  try {
    const devDb = await import('../../../scripts/dev-db.js');
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? devDb.LOCAL_URL;
    const { closePool } = await import('../../../src/db/pool.js');
    await closePool();
  } catch {
    // Nothing to close.
  }
  console.log('\n[qa-suite] teardown complete; PostgreSQL left running (npm run db:down to stop)\n');
}
