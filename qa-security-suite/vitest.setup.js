/**
 * Backend suite setup (Phases 1, 2 and 4).
 *
 * Runs once per backend test file, inside the worker, BEFORE the test file body
 * and therefore before any application module is imported. That ordering is the
 * whole point: src/config/env.js validates and freezes process.env at import
 * time, so every override below must land first.
 *
 * Nothing here touches the database -- see phase1/setup/global-setup.js.
 */
process.env.NODE_ENV = 'test';

// Silent by default so a passing run is readable. Set TEST_LOG_LEVEL=error (or
// debug) when a test fails and you need the server-side stack or SQL timing.
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';

// Long enough to satisfy the >= 32 character refinement in src/config/env.js.
process.env.JWT_SECRET = 'qa-suite-only-jwt-secret-abcdefghijklmnopqrstuvwxyz-0123456789';

// bcrypt is deliberately slow. The suite hashes every fixture, so the cost
// factor is dropped to the minimum the schema allows OUTSIDE production only.
process.env.BCRYPT_ROUNDS = '4';

// localhost over http: cookies cannot be `Secure` or the test client would have
// to speak TLS to a plaintext listener.
process.env.COOKIE_SECURE = 'false';

// Headroom so genuinely concurrent requests (the oversell race tests) each get
// their own connection instead of queueing behind a tiny pool.
process.env.DB_POOL_MAX = '16';

/*
 * Trust exactly one proxy hop, so `req.ip` honours the X-Forwarded-For header the
 * suite sets. Without this every Supertest request shares a single rate-limit
 * bucket, and per-IP isolation cannot be expressed at all.
 *
 * A test file can override this to assert the opposite: that a forged
 * X-Forwarded-For is ignored when no proxy is trusted.
 */
process.env.TRUST_PROXY = process.env.TRUST_PROXY ?? '1';

// The bundled local PostgreSQL cluster does not speak TLS. Without this, node-pg
// fails with "The server does not support SSL connections" -- a client
// misconfiguration that reads like a database outage. Only forced when the
// caller has not opted into a remote test database.
if (!process.env.TEST_DATABASE_URL) process.env.PGSSLMODE = 'disable';
