/**
 * Local development / test database manager.
 *
 *   npm run db:up    start PostgreSQL and create the database
 *   npm run db:down  stop it
 *
 * Why this exists: StockPulse's core guarantee -- that two concurrent orders can
 * never oversell the last unit -- depends on PostgreSQL's row-lock and
 * READ COMMITTED re-evaluation semantics. An in-memory Postgres emulator cannot
 * prove that, so this script runs a *real* server from the binaries vendored
 * under node_modules/@embedded-postgres/<platform>/native/bin. No system-wide
 * PostgreSQL install is required.
 *
 * If DATABASE_URL points at a server this script does not manage -- the Docker
 * Compose stack, or a managed instance -- it is respected and never duplicated:
 * either it is reachable and there is nothing to do, or the script fails with
 * instructions rather than quietly starting a second server on another port that
 * the application would never connect to.
 *
 * Two implementation notes:
 *  - `pg_ctl start` tries to create a restricted token, which fails (error 87)
 *    inside restricted/sandboxed environments. So we fall back to launching
 *    postgres.exe directly with the logging collector writing to a file.
 *  - Children are spawned with non-piped stdio. Nothing has to be captured, so
 *    the server survives independently of this short-lived process.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';
import 'dotenv/config';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.PGDATA_DIR ?? path.join(ROOT, '.pgdata');
const PORT = Number(process.env.PG_PORT ?? 55432);
const DB_NAME = process.env.PG_DATABASE ?? 'stockpulse';
const DB_USER = process.env.PG_USER ?? 'postgres';
const LOG_FILE = path.join(DATA_DIR, 'log', 'postgres.log');

const PLATFORM_PACKAGE = {
  win32: 'windows-x64',
  darwin: process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64',
  linux: process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64',
}[process.platform];

const BIN_DIR = path.join(
  ROOT,
  'node_modules',
  '@embedded-postgres',
  PLATFORM_PACKAGE ?? 'unsupported',
  'native',
  'bin',
);

const exe = (name) =>
  process.platform === 'win32' ? path.join(BIN_DIR, `${name}.exe`) : path.join(BIN_DIR, name);

const LOCAL_URL = `postgres://${DB_USER}@127.0.0.1:${PORT}/${DB_NAME}`;
const ADMIN_URL = `postgres://${DB_USER}@127.0.0.1:${PORT}/postgres`;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${path.basename(command)} exited with code ${result.status}`);
  }
  return result.status;
}

function connect(url) {
  return new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 1500,
    statement_timeout: 5000,
  });
}

/** Keeps a password out of terminals, logs and bug reports. */
function redact(url) {
  return String(url).replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
}

async function isReachable(url) {
  const client = connect(url);
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

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(ADMIN_URL)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function configureLogging() {
  const autoConf = path.join(DATA_DIR, 'postgresql.auto.conf');
  const desired = [
    `listen_addresses = '127.0.0.1'`,
    `port = ${PORT}`,
    `logging_collector = on`,
    `log_directory = 'log'`,
    `log_filename = 'postgres.log'`,
    `log_rotation_age = 0`,
    `log_truncate_on_rotation = on`,
  ].join('\n');

  if (existsSync(autoConf) && readFileSync(autoConf, 'utf8').includes('logging_collector')) return;
  appendFileSync(autoConf, `\n${desired}\n`);
}

function startServer() {
  const viaPgCtl = run(exe('pg_ctl'), ['start', '-D', DATA_DIR, '-l', LOG_FILE, '-w', '-t', '60'], {
    allowFailure: true,
  });
  if (viaPgCtl === 0) return 'pg_ctl';

  // Restricted-token failure: launch the postmaster directly instead.
  const child = spawn(exe('postgres'), ['-D', DATA_DIR], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return 'direct';
}

function stopServer() {
  const viaPgCtl = run(exe('pg_ctl'), ['stop', '-D', DATA_DIR, '-m', 'fast', '-w', '-t', '30'], {
    allowFailure: true,
  });
  if (viaPgCtl === 0) return true;

  // Fallback: signal the postmaster from its pid file.
  const pidFile = path.join(DATA_DIR, 'postmaster.pid');
  if (!existsSync(pidFile)) return false;
  const pid = Number.parseInt(readFileSync(pidFile, 'utf8').split('\n')[0], 10);
  if (!Number.isInteger(pid)) return false;
  run(exe('pg_ctl'), ['kill', 'INT', String(pid)], { allowFailure: true });
  return true;
}

export async function up() {
  const configured = process.env.DATABASE_URL;

  // DATABASE_URL points at a server this script does not own (Docker Compose or
  // a managed instance). Respect that choice: start nothing, and if it is down,
  // say so instead of starting a different server on a different port -- which
  // would leave the application connecting to nothing and the reason unclear.
  if (configured && configured !== LOCAL_URL) {
    if (await isReachable(configured)) {
      console.log(`A PostgreSQL server is already reachable at ${redact(configured)} -- nothing to do.`);
      return;
    }

    throw new Error(
      `DATABASE_URL is not reachable:\n  ${redact(configured)}\n\n` +
        `  Using Docker:  docker compose up -d --wait\n` +
        `  Without it:    point DATABASE_URL at the bundled server instead, then retry:\n` +
        `                 DATABASE_URL=${LOCAL_URL}`,
    );
  }

  if (!existsSync(exe('pg_ctl'))) {
    console.error(
      `PostgreSQL binaries not found at ${BIN_DIR}\n` +
        `Install them with:  npm install @embedded-postgres/${PLATFORM_PACKAGE}\n` +
        `or point DATABASE_URL at any running PostgreSQL 14+ instance.`,
    );
    process.exitCode = 1;
    return;
  }

  if (!IDENT.test(DB_NAME)) throw new Error(`Invalid database name: ${DB_NAME}`);

  mkdirSync(DATA_DIR, { recursive: true });

  if (!existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    console.log(`initialising a PostgreSQL cluster in ${DATA_DIR}`);
    run(exe('initdb'), ['-D', DATA_DIR, '-U', DB_USER, '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  }

  configureLogging();

  if (await isReachable(ADMIN_URL)) {
    console.log(`PostgreSQL already running on 127.0.0.1:${PORT}`);
  } else {
    console.log(`starting PostgreSQL on 127.0.0.1:${PORT}`);
    const mode = startServer();
    if (!(await waitForServer())) {
      console.error(
        `PostgreSQL did not become ready.\n` +
          `start mode: ${mode}\n` +
          (existsSync(LOG_FILE) ? `see ${LOG_FILE}` : ''),
      );
      process.exitCode = 1;
      return;
    }
  }

  const admin = connect(ADMIN_URL);
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE "${DB_NAME}"`);
      console.log(`created database "${DB_NAME}"`);
    }
  } finally {
    await admin.end();
  }

  console.log(`\nDATABASE_URL=${LOCAL_URL}\n`);
}

export async function down() {
  const configured = process.env.DATABASE_URL;

  // Only ever stop the cluster this script started. Reaching into a Docker
  // container from here would be surprising and is not ours to manage.
  if (configured && configured !== LOCAL_URL) {
    console.log(
      `${redact(configured)} is not managed by this script, so it was left running.\n` +
        `  Docker:  docker compose down`,
    );
    return;
  }

  if (!existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    console.log('no local cluster to stop');
    return;
  }
  if (!(await isReachable(ADMIN_URL))) {
    console.log('PostgreSQL is not running');
    return;
  }
  if (!stopServer()) {
    console.error('could not stop PostgreSQL; check the pid file in ' + DATA_DIR);
    process.exitCode = 1;
    return;
  }
  for (let i = 0; i < 40 && (await isReachable(ADMIN_URL)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log('PostgreSQL stopped');
}

export { LOCAL_URL };

// Only act as a CLI when executed directly; the test harness imports up().
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const action = process.argv[2];
  const entry = { up, down }[action];

  if (!entry) {
    console.error('usage: node scripts/dev-db.js <up|down>');
    process.exitCode = 1;
  } else {
    Promise.resolve(entry()).catch((error) => {
      // No log-file hint here: a failure may have nothing to do with the local
      // cluster (an unreachable DATABASE_URL, for instance), and up() already
      // points at the log when the local server is the problem.
      console.error(`dev-db ${action} failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}