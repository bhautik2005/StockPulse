/**
 * PostgreSQL connection pool.
 *
 * Two deliberate choices:
 *
 *  1. NUMERIC and BIGINT values are returned as strings. JavaScript numbers are
 *     IEEE-754 doubles; `0.1 + 0.2 !== 0.3`. Money must never round-trip through
 *     a float, so all currency arithmetic happens in SQL and arrives here as text.
 *
 *  2. Every connection carries server-side timeouts. Without them a single
 *     stuck query or blocked row lock holds a pool slot forever, and the whole
 *     API degrades to "pool exhausted" 500s while the database looks healthy.
 */
import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const isProduction = process.env.NODE_ENV === 'production';

const { Pool } = pg;

/**
 * TLS is negotiated only when the target actually speaks it.
 *
 * The managed database (Supabase) terminates TLS; a local PostgreSQL server --
 * the bundled cluster, Docker Compose, or a CI service container -- does not,
 * and asking it for SSL fails with "The server does not support SSL
 * connections", which reads like an outage rather than a client misconfiguration.
 *
 * Overrides, in order of precedence:
 *   PGSSLMODE=disable|allow|prefer|require|verify-ca|verify-full  (libpq spelling)
 *   PG_SSL=true|false
 *   NODE_ENV=production -> TLS on
 *   otherwise           -> no TLS
 */
function sslConfig() {
  const mode = process.env.PGSSLMODE;
  if (mode === 'disable' || mode === 'allow' || mode === 'prefer') return false;
  if (mode) return { rejectUnauthorized: false };

  if (process.env.PG_SSL === 'false') return false;
  if (process.env.PG_SSL === 'true') return { rejectUnauthorized: false };

  try {
    const url = new URL(env.DATABASE_URL);
    if (['localhost', '127.0.0.1', 'db'].includes(url.hostname)) {
      return false;
    }
  } catch {}

  return isProduction ? { rejectUnauthorized: false } : false;
}

let databaseUrlDiagnostics;
try {
  const databaseUrl = new URL(env.DATABASE_URL);
  databaseUrlDiagnostics = {
    parses: true,
    postgresScheme: ['postgres:', 'postgresql:'].includes(databaseUrl.protocol),
    hasHost: Boolean(databaseUrl.hostname),
    hasDatabase: Boolean(databaseUrl.pathname.slice(1)),
    ssl: Boolean(sslConfig()),
  };
} catch {
  databaseUrlDiagnostics = { parses: false };
}
console.log('DEBUG RUNTIME DATABASE_URL:', databaseUrlDiagnostics);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: env.DB_POOL_ACQUIRE_TIMEOUT_MS,
  statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  lock_timeout: env.DB_LOCK_TIMEOUT_MS,
  application_name: 'stockpulse-api',
  family: 4, // <-- ADDED: Forces IPv4 to fix Render's ENETUNREACH cloud deployment crash
  ssl: sslConfig(),
});

// A pool-level error means an *idle* client died (network blip, DB restart).
// Left unhandled this is an unhandled 'error' event and kills the process.
pool.on('error', (err) => {
  logger.error('idle postgres client error', { error: err.message, code: err.code });
});

/** Run a single statement on any available pooled connection. */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run `fn` inside a single ACID transaction on one dedicated connection.
 *
 * READ COMMITTED is the correct default here: the conditional UPDATE in the
 * order path re-evaluates its WHERE clause against the newest committed row
 * after any lock wait, which is exactly the semantics that make overselling
 * impossible without paying for SERIALIZABLE retry loops.
 */
export async function withTransaction(fn, { isolation = 'READ COMMITTED' } = {}) {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Losing the rollback must be loud: the connection is now unusable.
      logger.error('transaction rollback failed', {
        error: rollbackError.message,
        original: error.message,
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Lightweight liveness probe used by /health. */
export async function checkDatabase() {
  const startedAt = Date.now();
  await pool.query('SELECT 1');
  return { ok: true, latencyMs: Date.now() - startedAt };
}

/**
 * Pool saturation, exposed on /health. A pool that is fully checked out with a
 * queue forming is the earliest signal that latency is about to collapse.
 */
export function poolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: env.DB_POOL_MAX,
  };
}

export async function closePool() {
  await pool.end();
}