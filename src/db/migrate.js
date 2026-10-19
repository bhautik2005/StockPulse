/**
 * Forward-only SQL migration runner.
 *
 * Each migration is applied inside its own transaction and recorded with a
 * checksum, so editing an already-applied migration is detected and refused
 * instead of silently diverging between machines.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { closePool, pool } from './pool.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text        PRIMARY KEY,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function migrate({ fresh = false } = {}) {
  const client = await pool.connect();
  try {
    if (fresh) {
      if (env.isProduction) {
        throw new Error('Refusing to run --fresh with NODE_ENV=production');
      }
      logger.warn('dropping schema public and rebuilding from scratch');
      await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    }

    await ensureMigrationsTable(client);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Map(
      (await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map((r) => [
        r.filename,
        r.checksum,
      ]),
    );

    let appliedCount = 0;

    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(file);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was modified after it was applied. ` +
              'Migrations are forward-only: add a new file instead of editing this one.',
          );
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        appliedCount += 1;
        logger.info('migration applied', { file });
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${error.message}`);
      }
    }

    return appliedCount;
  } finally {
    client.release();
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  migrate({ fresh: process.argv.includes('--fresh') })
    .then((count) => {
      logger.info(count === 0 ? 'database already up to date' : `applied ${count} migration(s)`);
    })
    .catch((error) => {
      logger.error('migration failed', { error: error.message });
      process.exitCode = 1;
    })
    .finally(closePool);
}