/**
 * QA suite :: embedded PostgreSQL launcher.
 *
 * Why this exists instead of `npm run db:up`:
 *
 *  - `pg_ctl start` launches the postmaster *detached*, so whatever process
 *    group the caller belongs to owns it. In a sandboxed or job-object-managed
 *    shell (Windows CI runners do this too) the server is killed the moment the
 *    launching command returns, which surfaces as the confusing
 *    "the database system is in recovery mode" during the very next step.
 *  - `pg_ctl` also enables `logging_collector`, and the log collector reopens
 *    its log file on rotation. Where that file cannot be reopened, the postmaster
 *    exits and restarts in a loop.
 *
 * So this launcher starts `postgres` as a child of the CURRENT process, with
 * `logging_collector=off` (the server's own stderr goes to a log file we manage)
 * and keeps the child alive until it is explicitly stopped. Test runners and
 * debug sessions therefore keep their database for exactly as long as they run.
 *
 * Usage:
 *   node qa-security-suite/phase2/scripts/embedded-postgres.js up
 *   node qa-security-suite/phase2/scripts/embedded-postgres.js up --wait
 *   node qa-security-suite/phase2/scripts/embedded-postgres.js status
 *   node qa-security-suite/phase2/scripts/embedded-postgres.js down
 *
 * As a module:
 *   const pg = await import('./embedded-postgres.js');
 *   await pg.up();                 // starts if needed, resolves when ready
 *   await pg.runVitest(['run']);   // runs npx vitest and returns the exit code
 *   await pg.down();
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DATA_DIR = process.env.PGDATA_DIR ?? path.join(ROOT, '.pgdata');
const PORT = Number(process.env.PG_PORT ?? 55432);
const DB_NAME = process.env.PG_DATABASE ?? 'stockpulse';
const DB_USER = process.env.PG_USER ?? 'postgres';
const LOG_FILE = path.join(DATA_DIR, 'log', 'embedded-postgres.log');

const PLATFORM_PACKAGE = {
  win32: 'windows-x64',
  darwin: process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64',
  linux: process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64',
}[process.platform];

const BIN_DIR = path.join(ROOT, 'node_modules', '@embedded-postgres', PLATFORM_PACKAGE ?? 'unsupported', 'native', 'bin');

const exe = (name) => (process.platform === 'win32' ? path.join(BIN_DIR, `${name}.exe`) : path.join(BIN_DIR, name));

export const LOCAL_URL = `postgres://${DB_USER}@127.0.0.1:${PORT}/${DB_NAME}`;
const ADMIN_URL = `postgres://${DB_USER}@127.0.0.1:${PORT}/postgres`;

let child = null;

/** A single connection attempt with a short timeout. No TLS: this is loopback. */
async function probe(url, { timeoutMs = 1500 } = {}) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: 5000,
    ssl: false,
  });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/** True when *our* cluster is accepting connections on PORT. */
export function isReachable() {
  return probe(ADMIN_URL);
}

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * Starts the bundled server if it is not already up.
 *
 * Resolves once the server accepts connections. The child is a child of this
 * process: it dies when this process dies, which is the property that makes the
 * suite deterministic.
 */
export async function up({ timeoutMs = 60_000 } = {}) {
  if (await isReachable()) return { started: false, url: LOCAL_URL };

  if (!existsSync(exe('postgres'))) {
    throw new Error(
      `PostgreSQL binaries not found at ${BIN_DIR}\n` +
        `Install them with:  npm install @embedded-postgres/${PLATFORM_PACKAGE}\n` +
        `or point TEST_DATABASE_URL at any running PostgreSQL 14+ instance.`,
    );
  }

  if (!existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    mkdirSync(DATA_DIR, { recursive: true });
    mkdirSync(path.join(DATA_DIR, 'log'), { recursive: true });
    const init = spawnSync(
      exe('initdb'),
      ['-D', DATA_DIR, '-U', DB_USER, '-A', 'trust', '--encoding=UTF8', '--locale=C'],
      { stdio: 'inherit', windowsHide: true },
    );
    if (init.status !== 0) throw new Error(`initdb exited with code ${init.status}`);
  }

  mkdirSync(path.join(DATA_DIR, 'log'), { recursive: true });
  const logFd = openSync(LOG_FILE, 'a');

  child = spawn(
    exe('postgres'),
    [
      '-D',
      DATA_DIR,
      '-c',
      `listen_addresses=127.0.0.1`,
      '-c',
      `port=${PORT}`,
      // The collector is what makes the server exit when its log file cannot be
      // reopened; stderr redirection gives the same information without that risk.
      '-c',
      'logging_collector=off',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ],
    { stdio: ['ignore', logFd, logFd], windowsHide: true, detached: false },
  );

  child.on('exit', (code) => {
    child = null;
    if (code !== 0 && code !== null) {
      // Surfaced rather than swallowed: a dead server is why the next query fails.
      console.error(`[qa-pg] postgres exited with code ${code}; see ${LOG_FILE}`);
    }
  });

  if (!(await waitForReady(timeoutMs))) {
    const tail = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8').split('\n').slice(-25).join('\n') : '(no log)';
    throw new Error(`PostgreSQL did not become ready within ${timeoutMs}ms.\nLast lines of ${LOG_FILE}:\n${tail}`);
  }

  // The application database must exist before migrations can run.
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2000, ssl: false });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    if (rowCount === 0) await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await admin.end();
  }

  return { started: true, url: LOCAL_URL };
}

/** Stops the server this module started (no-op if it did not start one). */
export async function down({ timeoutMs = 20_000 } = {}) {
  if (!child) return { stopped: false };
  const pid = child.pid;
  child = null;

  if (process.platform === 'win32') {
    // A fast shutdown, addressed by pid, is the only reliable Windows path.
    spawnSync(exe('pg_ctl'), ['kill', '-INT', String(pid)], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(pid, 'SIGINT');
    } catch {
      // Already gone.
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isReachable())) return { stopped: true };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { stopped: false };
}

/**
 * Runs `npx vitest` with the given arguments from the project root.
 *
 * Used by scripts/run-suite.mjs so the server stays a child of one process for
 * the whole run instead of being stranded between two shell commands.
 */
export function runVitest(args = [], { env = {} } = {}) {
  writeFileSync(path.join(DATA_DIR, 'log', 'last-vitest-args.txt'), args.join(' '), 'utf8');

  return new Promise((resolve) => {
    const runner = spawn('npx', ['vitest', ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
      shell: process.platform === 'win32',
      env: { ...process.env, ...env },
    });
    runner.on('exit', (code) => resolve(code ?? 1));
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const action = process.argv[2] ?? 'status';

  try {
    if (action === 'up') {
      const result = await up();
      console.log(result.started ? `[qa-pg] started ${result.url}` : `[qa-pg] already running ${result.url}`);
      if (process.argv.includes('--wait')) {
        console.log('[qa-pg] --wait: keeping the server attached to this process; press Ctrl+C to stop');
        await new Promise((resolve) => {
          process.on('SIGINT', resolve);
          process.on('SIGTERM', resolve);
        });
        await down();
      }
    } else if (action === 'down') {
      const result = await down();
      console.log(result.stopped ? '[qa-pg] stopped' : '[qa-pg] nothing to stop (not started by this process)');
    } else if (action === 'status') {
      console.log(`[qa-pg] ${(await isReachable()) ? 'reachable' : 'not reachable'} at ${LOCAL_URL}`);
    } else {
      console.error('usage: node qa-security-suite/phase2/scripts/embedded-postgres.js <up|down|status> [--wait]');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[qa-pg] ${action} failed: ${error.message}`);
    process.exitCode = 1;
  }
}
