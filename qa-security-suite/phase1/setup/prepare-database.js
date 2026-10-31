/**
 * QA suite :: database bootstrap shared by the Vitest harness and global setup.
 *
 * Resolves DATABASE_URL for the suite, in this order:
 *
 *   1. TEST_DATABASE_URL    -- explicit opt-in (CI, a disposable Supabase
 *                              project, a Docker service). Never rebuilt unless
 *                              the operator asked for it.
 *   2. the bundled embedded cluster, if something is already listening on it.
 *   3. the bundled embedded cluster, started through scripts/dev-db.js.
 *
 * Step 2 is what keeps the suite robust: `scripts/dev-db.js` starts the server
 * with `pg_ctl start`, detached. Nothing is wrong with that for interactive use,
 * but in a job-object-managed shell the detached server is killed the moment the
 * launching command returns. When a launcher has already brought the cluster up
 * (see phase2/scripts/embedded-postgres.js and scripts/run-suite.mjs), this
 * module notices and simply uses it.
 *
 * The production DATABASE_URL from .env is ALWAYS discarded: `resetDatabase()`
 * drops the schema, so pointing the suite at .env would wipe a live database.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

const PORT = Number(process.env.PG_PORT ?? 55432);
const DB_USER = process.env.PG_USER ?? 'postgres';
const DB_NAME = process.env.PG_DATABASE ?? 'stockpulse';

const LOCAL_URL = `postgres://${DB_USER}@127.0.0.1:${PORT}/${DB_NAME}`;
const ADMIN_URL = `postgres://${DB_USER}@127.0.0.1:${PORT}/postgres`;

/** A plain, TLS-free connection attempt with a short timeout. */
async function reachable(url) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1200, ssl: false });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Ensures a database is available and pins process.env.DATABASE_URL to it.
 *
 * @returns {Promise<{url: string, source: 'env'|'already-running'|'dev-db'}>}
 */
export async function prepareDatabase({ quiet = false } = {}) {
  const log = quiet ? () => {} : (message) => console.log(message);

  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    if (!process.env.PGSSLMODE && !process.env.PG_SSL) process.env.PGSSLMODE = 'require';
    log(`[qa-suite] using TEST_DATABASE_URL (schema will be rebuilt): ${redact(process.env.TEST_DATABASE_URL)}`);
    return { url: process.env.DATABASE_URL, source: 'env' };
  }

  // The bundled cluster is loopback and plaintext: never ask it for TLS.
  process.env.PGSSLMODE = 'disable';
  delete process.env.DATABASE_URL;

  if (await reachable(ADMIN_URL)) {
    process.env.DATABASE_URL = LOCAL_URL;
    log('[qa-suite] embedded PostgreSQL already running; reusing it');
    return { url: LOCAL_URL, source: 'already-running' };
  }

  const devDb = await import(pathToFileURL(path.join(ROOT, 'scripts', 'dev-db.js')).href);
  await devDb.up();
  process.env.DATABASE_URL = devDb.LOCAL_URL;

  if (!(await reachable(devDb.LOCAL_URL))) {
    throw new Error(
      `The embedded PostgreSQL server did not become reachable at ${devDb.LOCAL_URL}.\n` +
        'If you are running inside a shell that kills detached processes, start the suite with\n' +
        '  node qa-security-suite/scripts/run-suite.mjs run --project backend\n' +
        'or provide TEST_DATABASE_URL pointing at any PostgreSQL 14+ instance.',
    );
  }

  return { url: devDb.LOCAL_URL, source: 'dev-db' };
}

/** Keeps a password out of logs, terminals and bug reports. */
export function redact(url) {
  return String(url).replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
}

export { LOCAL_URL, ADMIN_URL, ROOT };
