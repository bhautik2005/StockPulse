/**
 * QA suite :: one-command runner.
 *
 *   node qa-security-suite/scripts/run-suite.mjs [vitest args...]
 *
 * Starts the embedded PostgreSQL server as a child of THIS process, runs Vitest,
 * then stops the server again. That single-process lifetime is the point:
 * `pg_ctl start` detaches the postmaster, and in job-object-managed shells
 * (Windows sandboxes, some CI runners) the detached server is killed the moment
 * the launching command returns -- producing "the database system is in recovery
 * mode" in the very next step.
 *
 * With TEST_DATABASE_URL set, no embedded server is started at all and the suite
 * runs against whatever you pointed it at.
 *
 * Examples:
 *   node qa-security-suite/scripts/run-suite.mjs run
 *   node qa-security-suite/scripts/run-suite.mjs run --project backend
 *   node qa-security-suite/scripts/run-suite.mjs run --project frontend
 *   node qa-security-suite/scripts/run-suite.mjs run qa-security-suite/phase1/tests/auth.integration.test.js
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const { up, down } = await import('../phase2/scripts/embedded-postgres.js');

const args = process.argv.slice(2);
const vitestArgs = args.length > 0 ? args : ['run'];

let startedHere = false;

try {
  if (!process.env.TEST_DATABASE_URL) {
    const result = await up();
    startedHere = result.started;
    console.log(`[qa-suite] database ${startedHere ? 'started' : 'already running'}: ${result.url}`);
  } else {
    console.log('[qa-suite] TEST_DATABASE_URL set; using it as-is');
  }

  const exitCode = await new Promise((resolve) => {
    const runner = spawn('npx', ['vitest', ...vitestArgs], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    runner.on('exit', (code) => resolve(code ?? 1));
  });

  process.exitCode = exitCode;
} catch (error) {
  console.error(`[qa-suite] run failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (startedHere) {
    const { stopped } = await down();
    console.log(stopped ? '[qa-suite] database stopped' : '[qa-suite] database left running');
  }
}
