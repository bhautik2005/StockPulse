/**
 * Test harness.
 *
 * Responsibilities, in order:
 *   1. Pin the environment *before* any application module is imported, because
 *      src/config/env.js validates and freezes configuration at import time.
 *   2. Bring up a real PostgreSQL server (a real one, never an emulator: the
 *      concurrency guarantees under test are PostgreSQL semantics).
 *   3. Rebuild the schema from scratch for every test file, giving each file a
 *      known-empty database.
 *   4. Start the Express app on an ephemeral port.
 *
 * Application modules are imported dynamically, after step 1 -- a static import
 * would be hoisted above the environment assignments and read the wrong config.
 */
process.env.NODE_ENV = 'test';
// Set TEST_LOG_LEVEL=error (or debug) to see server-side stacks while debugging.
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.JWT_SECRET = 'test-only-jwt-secret-with-enough-characters-1234567890';
process.env.COOKIE_SECURE = 'false';
// Low cost factor: bcrypt is deliberately slow, and the suite hashes a lot of
// fixtures. Production uses the value from .env (>= 10).
process.env.BCRYPT_ROUNDS = '4';
// Headroom so genuinely concurrent requests each get their own connection.
process.env.DB_POOL_MAX = '16';

/*
 * The suite owns its database.
 *
 * It must never inherit the developer's DATABASE_URL: resetDatabase() drops and
 * rebuilds the schema, so pointing the tests at .env would wipe a seeded
 * development or Docker database on every run. LOCAL_URL is the bundled server
 * on its own port; set TEST_DATABASE_URL to run the suite elsewhere (CI).
 *
 * Imported before src/db/pool.js and src/config/env.js, which read the URL at
 * import time.
 */
const { up, LOCAL_URL } = await import('../../scripts/dev-db.js');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? LOCAL_URL;

const { migrate } = await import('../../src/db/migrate.js');
const { createApp } = await import('../../src/app.js');
const { pool, closePool, query } = await import('../../src/db/pool.js');
const { env } = await import('../../src/config/env.js');
const { hashPassword } = await import('../../src/lib/password.js');

export { pool, query, closePool, env };

/** Ensures the server is running and the schema is empty and current. */
export async function resetDatabase() {
  await up();
  await migrate({ fresh: true });
}

/** Starts the API on an ephemeral port. */
export async function startServer() {
  const app = createApp();

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  const { port } = server.address();

  return {
    app,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

/**
 * Creates the very first administrator directly in the database.
 *
 * This mirrors what the seed script does, and is the only place in the whole
 * system where an account is created without an Admin's authority -- which is
 * exactly why it is confined to a bootstrap script rather than exposed over
 * HTTP.
 */
export async function bootstrapAdmin({ email = 'root@stockpulse.test', password = 'AdminPass1234' } = {}) {
  const passwordHash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'Admin')
     RETURNING id, email, role`,
    ['Root Admin', email, passwordHash],
  );
  return { ...rows[0], password };
}

/** Convenience for tests that inspect a single scalar. */
export async function scalar(sql, params = []) {
  const { rows } = await query(sql, params);
  const first = rows[0];
  return first ? Object.values(first)[0] : undefined;
}

/** Runs `fn` for each index, concurrently, and returns settled results. */
export function concurrently(count, fn) {
  return Promise.all(Array.from({ length: count }, (_, index) => fn(index)));
}