/**
 * Phase 1 :: Auth controller integration tests.
 *
 * Exercises POST /api/auth/register, POST /api/auth/login and GET /api/auth/me
 * over the real HTTP stack -- routing, validation, cookie handling, JWT signing
 * and the error envelope -- against a real PostgreSQL database.
 *
 * Supertest drives the Express app in-process. Nothing is mocked: the JWT that
 * comes back is a real JWT signed by the real secret, and the row it represents
 * is a real row in the database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app, env, resetDatabase, scalar } from '../setup/db.js';
import { createClient, isError } from '../helpers/client.js';
import { adminSession, createSimpleWorld, createUser, uniqueKey, PASSWORD } from '../helpers/fixtures.js';

const REGISTER = '/api/auth/register';
const LOGIN = '/api/auth/login';
const ME = '/api/auth/me';

let world;

beforeAll(async () => {
  await resetDatabase();
  world = await createSimpleWorld();
});

afterAll(async () => {
  const { closePool } = await import('../setup/db.js');
  await closePool();
});

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------

describe('Phase 1 :: POST /api/auth/register', () => {
  it('creates a Client account and returns 201 with the public projection', async () => {
    const api = createClient(app);
    const email = `new-${uniqueKey()}@client.test`;

    const response = await api.post(REGISTER, { name: 'Ada Lovelace', email, password: PASSWORD });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      data: { name: 'Ada Lovelace', email, role: 'Client', is_active: true },
    });
    expect(typeof response.body.data.id).toBe('number');

    // The password hash must never travel back over the wire, and neither must
    // any internal session state.
    const leaked = JSON.stringify(response.body);
    expect(leaked).not.toMatch(/password_hash|\$2[aby]\$|token_version/);
  });

  it('cannot be used to self-register a privileged role', async () => {
    const api = createClient(app);
    const email = `escalation-${uniqueKey()}@client.test`;

    // Zod strips unknown keys, so `role` is dropped rather than honoured.
    const response = await api.post(REGISTER, {
      name: 'Privilege Escalation',
      email,
      password: PASSWORD,
      role: 'Admin',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.role).toBe('Client');

    const stored = await scalar('SELECT role FROM users WHERE email = $1', [email]);
    expect(stored).toBe('Client');
  });

  it('rejects a duplicate email with 409 EMAIL_IN_USE', async () => {
    const api = createClient(app);
    const email = `dupe-${uniqueKey()}@client.test`;
    const payload = { name: 'First Owner', email, password: PASSWORD };

    const first = await api.post(REGISTER, payload);
    expect(first.status).toBe(201);

    const second = await api.post(REGISTER, { ...payload, name: 'Second Owner' });

    expect(second.status).toBe(409);
    expect(isError(second, 'EMAIL_IN_USE')).toBe(true);
    expect(second.body.error.message).toMatch(/already exists/i);
    // The envelope is uniform, so a client can branch on code alone.
    expect(second.body.error).toHaveProperty('requestId');
  });

  it('treats an email as case-insensitive for uniqueness', async () => {
    const api = createClient(app);
    const email = `Case-${uniqueKey()}@Client.test`;

    const first = await api.post(REGISTER, { name: 'Case Owner', email, password: PASSWORD });
    expect(first.status).toBe(201);

    const second = await api.post(REGISTER, {
      name: 'Case Owner Again',
      email: email.toLowerCase(),
      password: PASSWORD,
    });

    // The functional unique index is on lower(email); a plain UNIQUE(email)
    // would have let both of these exist.
    expect(second.status).toBe(409);
    expect(isError(second, 'EMAIL_IN_USE')).toBe(true);
  });

  it('rejects a password shorter than 12 characters with 422', async () => {
    const api = createClient(app);

    const response = await api.post(REGISTER, {
      name: 'Short Password',
      email: `short-${uniqueKey()}@client.test`,
      password: 'Short1!',
    });

    expect(response.status).toBe(422);
    expect(isError(response, 'VALIDATION_FAILED')).toBe(true);
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'password', message: expect.stringMatching(/12 characters/) })]),
    );
  });

  it('rejects a malformed email with 422 and points at the field', async () => {
    const api = createClient(app);

    const response = await api.post(REGISTER, {
      name: 'Bad Email',
      email: 'not-an-email',
      password: PASSWORD,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'email' })]),
    );
  });

  it('rejects a password longer than the bcrypt 72-byte limit', async () => {
    const api = createClient(app);

    const response = await api.post(REGISTER, {
      name: 'Long Password',
      email: `long-${uniqueKey()}@client.test`,
      password: 'a'.repeat(73),
    });

    // Truncation would silently make two different passwords equivalent.
    expect(response.status).toBe(422);
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'password', message: expect.stringMatching(/72/) })]),
    );
  });

  it('rejects an empty body with 422 rather than 500', async () => {
    const api = createClient(app);
    const response = await api.post(REGISTER, {});
    expect(response.status).toBe(422);
    expect(isError(response, 'VALIDATION_FAILED')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

describe('Phase 1 :: POST /api/auth/login', () => {
  it('returns 200, a signed JWT and both cookies for valid credentials', async () => {
    const api = createClient(app);
    const email = `login-${uniqueKey()}@client.test`;

    await api.post(REGISTER, { name: 'Login Owner', email, password: PASSWORD });
    const response = await api.login(email, PASSWORD);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ email, role: 'Client' });

    // The body token exists purely for non-browser clients (Postman, CI); the
    // SPA is expected to ignore it in favour of the cookie.
    expect(typeof response.body.token).toBe('string');
    expect(response.body.token.split('.')).toHaveLength(3);
    expect(response.body.meta.csrf_token).toMatch(/^[0-9a-f]{64}$/);

    const setCookie = ([]).concat(response.headers['set-cookie'] ?? []).join('\n');
    expect(setCookie).toContain(`${env.COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain(`${env.CSRF_COOKIE_NAME}=`);
  });

  it('issues a JWT whose subject is the real user id', async () => {
    const api = createClient(app);
    const email = `subject-${uniqueKey()}@client.test`;
    const registered = await api.post(REGISTER, { name: 'Subject Owner', email, password: PASSWORD });

    const response = await api.login(email, PASSWORD);
    const payload = JSON.parse(Buffer.from(response.body.token.split('.')[1], 'base64url').toString('utf8'));

    expect(payload.sub).toBe(String(registered.body.data.id));
    expect(payload.role).toBe('Client');
    expect(payload.tv).toBe(0);
    expect(payload.exp).toBeGreaterThan(payload.iat);
    expect(payload.iss).toBe('stockpulse');
  });

  it('returns 401 INVALID_CREDENTIALS for a wrong password', async () => {
    const api = createClient(app);
    const email = `wrongpass-${uniqueKey()}@client.test`;
    await api.post(REGISTER, { name: 'Wrong Pass', email, password: PASSWORD });

    const response = await api.login(email, 'DefinitelyNotIt1234');

    expect(response.status).toBe(401);
    expect(isError(response, 'INVALID_CREDENTIALS')).toBe(true);
  });

  it('returns the identical 401 for an unknown email (no account enumeration)', async () => {
    const api = createClient(app);

    const unknown = await api.login(`ghost-${uniqueKey()}@nowhere.test`, PASSWORD);
    const known = createClient(app);
    const email = `known-${uniqueKey()}@client.test`;
    await known.post(REGISTER, { name: 'Known', email, password: PASSWORD });
    const wrong = await known.login(email, 'DefinitelyNotIt1234');

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    // Byte-for-byte identical: any difference here is an oracle that reveals
    // which email addresses are registered.
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('returns 422 when the password field is missing', async () => {
    const api = createClient(app);
    const response = await api.post(LOGIN, { email: 'someone@client.test' });

    expect(response.status).toBe(422);
    expect(isError(response, 'VALIDATION_FAILED')).toBe(true);
  });

  it('returns 403 ACCOUNT_DISABLED once an Admin deactivates the account', async () => {
    const api = createClient(app);
    const email = `disabled-${uniqueKey()}@client.test`;
    const registered = await api.post(REGISTER, { name: 'Disabled Owner', email, password: PASSWORD });

    await world.admin.api.patch(`/api/users/${registered.body.data.id}`, { is_active: false });

    const response = await api.login(email, PASSWORD);
    expect(response.status).toBe(403);
    expect(isError(response, 'ACCOUNT_DISABLED')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

describe('Phase 1 :: GET /api/auth/me', () => {
  it('returns 401 without any credential', async () => {
    const api = createClient(app);
    const response = await api.get(ME);

    expect(response.status).toBe(401);
    expect(response.body.error).toHaveProperty('code');
  });

  it('returns 401 for a token signed with the wrong secret', async () => {
    const jsonwebtoken = (await import('jsonwebtoken')).default;
    const forged = jsonwebtoken.sign({ sub: 1, tv: 0 }, 'not-the-real-secret-not-the-real-secret', {
      expiresIn: '15m',
    });

    const api = createClient(app);
    api.useBearer(forged);
    const response = await api.get(ME);

    expect(response.status).toBe(401);
    expect(isError(response, 'TOKEN_INVALID')).toBe(true);
  });

  it('returns 401 for a malformed token', async () => {
    const api = createClient(app);
    api.useBearer('not.a.jwt');

    const response = await api.get(ME);
    expect(response.status).toBe(401);
  });

  it('returns the caller profile and warehouse scope for a Client', async () => {
    const response = await world.client.api.get(ME);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: world.client.id,
      email: world.client.email,
      role: 'Client',
      // A Client never has warehouse scope: they buy from the catalogue, they do
      // not operate a warehouse.
      scope: { all: false, ids: [] },
    });
    // The CSRF token is echoed so a cross-origin SPA can keep it in memory.
    expect(response.body.meta.csrf_token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns scope.all for an Admin', async () => {
    const response = await world.admin.api.get(ME);

    expect(response.status).toBe(200);
    expect(response.body.data.scope).toEqual({ all: true, ids: null });
  });

  it('rejects a revoked session with 401 TOKEN_REVOKED after a role change', async () => {
    const creator = await adminSession();
    const staff = await createUser(creator.api, { role: 'Staff' });

    const session = createClient(app);
    await session.login(staff.email, staff.password);
    expect((await session.get(ME)).status).toBe(200);

    // Demoting the user bumps token_version, so the live token stops working.
    await creator.api.patch(`/api/users/${staff.id}`, { role: 'Client' });

    const after = await session.get(ME);
    expect(after.status).toBe(401);
    expect(isError(after, 'TOKEN_REVOKED')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CSRF double-submit on cookie-authenticated mutations
// ---------------------------------------------------------------------------

describe('Phase 1 :: CSRF protection on the cookie session', () => {
  it('rejects a cookie-authenticated POST that omits X-CSRF-Token with 403', async () => {
    const api = createClient(app);
    const email = `csrf-${uniqueKey()}@client.test`;
    await api.post(REGISTER, { name: 'CSRF Owner', email, password: PASSWORD });
    await api.login(email, PASSWORD);

    // Stay on the cookie session: this is the browser's default behaviour.
    api.useCookieSession();

    const response = await api.post('/api/orders', { items: [] }, { omitCsrf: true });

    expect(response.status).toBe(403);
    expect(isError(response, 'CSRF_FAILED')).toBe(true);
  });

  it('accepts the same request when the double-submit token is present', async () => {
    const api = createClient(app);
    const email = `csrf-ok-${uniqueKey()}@client.test`;
    await api.post(REGISTER, { name: 'CSRF OK', email, password: PASSWORD });
    await api.login(email, PASSWORD);
    api.useCookieSession();

    expect(api.csrfToken).toMatch(/^[0-9a-f]{64}$/);

    // Empty items -> 422 from validation, which proves the request got past the
    // CSRF gate and into the application.
    const response = await api.post('/api/orders', { items: [] });
    expect(response.status).toBe(422);
    expect(isError(response, 'VALIDATION_FAILED')).toBe(true);
  });

  it('exempts a Bearer-authenticated request from CSRF (no ambient cookie)', async () => {
    const api = createClient(app);
    const email = `csrf-bearer-${uniqueKey()}@client.test`;
    await api.post(REGISTER, { name: 'Bearer Owner', email, password: PASSWORD });
    const login = await api.login(email, PASSWORD);

    /*
     * Impersonate a non-browser client (Postman, CI, a server-to-server job).
     *
     * `clearAuth()` drops the cookie jar, and that is not incidental: when a
     * request carries BOTH the session cookie and an Authorization header,
     * src/lib/tokens.js extractToken() prefers the cookie (line 45), so the
     * request is CSRF-checked despite the Bearer token. Cookies are ambient --
     * they are attached by the browser whether the caller intended it or not --
     * so preferring the cookie is the safe reading. A genuine API client has no
     * cookies, and that is the case this test covers.
     */
    api.clearAuth();
    api.useBearer(login.body.token);

    const response = await api.post('/api/orders', { items: [] }, { omitCsrf: true });

    // A Bearer token is never attached automatically by a browser, so it carries
    // no CSRF risk -- and CI/Postman clients work without ceremony.
    expect(response.status).toBe(422);
    expect(isError(response, 'VALIDATION_FAILED')).toBe(true);
  });

  it('prefers the cookie session when a request carries both credentials', async () => {
    const api = createClient(app);
    const email = `csrf-both-${uniqueKey()}@client.test`;
    await api.post(REGISTER, { name: 'Both Owner', email, password: PASSWORD });
    const login = await api.login(email, PASSWORD);
    api.useBearer(login.body.token); // jar still holds sp_token

    const response = await api.post('/api/orders', { items: [] }, { omitCsrf: true });

    // Documents the precedence deliberately: the ambient credential wins, so an
    // attacker cannot downgrade a browser session out of CSRF protection by
    // adding an Authorization header.
    expect(response.status).toBe(403);
    expect(isError(response, 'CSRF_FAILED')).toBe(true);
  });
});
