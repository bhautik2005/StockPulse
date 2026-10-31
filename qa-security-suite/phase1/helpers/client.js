/**
 * Phase 1 :: In-process HTTP client for Supertest.
 *
 * Why not Supertest's own `request.agent(app)`? Because that agent hides the
 * cookie jar, and this suite has to *assert on the security layer itself*:
 * HttpOnly flags, the CSRF double-submit cookie, and the fact that a
 * cookie-authenticated mutation without X-CSRF-Token is rejected. A jar that
 * manages cookies invisibly makes those properties untestable.
 *
 * So this client keeps an explicit cookie map. One client == one browser
 * session, which is what lets a test hold an Admin session and a Client session
 * at the same time (the RBAC tests depend on exactly that).
 */
import supertest from 'supertest';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createClient(app) {
  const cookies = new Map();
  let bearerToken = null;

  function cookieHeader() {
    return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  function absorbSetCookie(response) {
    const raw = response.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];

    for (const entry of list) {
      const [pair] = String(entry).split(';');
      const separator = pair.indexOf('=');
      if (separator === -1) continue;

      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();

      // An empty value means the server cleared the cookie (logout).
      if (value === '') cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  async function send(method, path, { body, query, headers = {}, omitCsrf = false } = {}) {
    const pending = supertest(app)[method.toLowerCase()](path);

    if (query) {
      const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null);
      pending.query(Object.fromEntries(entries));
    }

    const cookie = cookieHeader();
    if (cookie) pending.set('cookie', cookie);
    if (bearerToken) pending.set('authorization', `Bearer ${bearerToken}`);

    // Double-submit CSRF: echo the readable cookie, exactly as the SPA does.
    // `omitCsrf` is the deliberate negative case.
    if (!omitCsrf && !SAFE_METHODS.has(method) && cookies.has('sp_csrf')) {
      pending.set('x-csrf-token', cookies.get('sp_csrf'));
    }

    for (const [name, value] of Object.entries(headers)) pending.set(name, value);

    const response = await (body === undefined ? pending : pending.send(body));
    absorbSetCookie(response);
    return response;
  }

  return {
    get: (path, options) => send('GET', path, options),
    post: (path, body, options) => send('POST', path, { ...options, body: body ?? {} }),
    patch: (path, body, options) => send('PATCH', path, { ...options, body: body ?? {} }),
    delete: (path, options) => send('DELETE', path, options),
    put: (path, body, options) => send('PUT', path, { ...options, body: body ?? {} }),
    options: (path, options) => send('OPTIONS', path, options),

    /** Signs in, keeps the cookies, and switches to Bearer for mutations. */
    async login(email, password) {
      const response = await send('POST', '/api/auth/login', { body: { email, password } });
      if (response.status === 200 && response.body?.token) bearerToken = response.body.token;
      return response;
    },

    /**
     * Keeps using the cookie session instead of Bearer.
     *
     * This is how the CSRF tests exercise the browser flow: with a cookie
     * session, a state-changing request must carry X-CSRF-Token.
     */
    useCookieSession() {
      bearerToken = null;
    },

    useBearer(token) {
      bearerToken = token;
    },

    clearAuth() {
      bearerToken = null;
      cookies.clear();
    },

    get csrfToken() {
      return cookies.get('sp_csrf') ?? null;
    },

    get cookies() {
      return cookies;
    },
  };
}

/** True when the response carries the expected machine-readable error code. */
export function isError(response, code) {
  return response.body?.error?.code === code;
}

/**
 * Distinct IPs for the rate-limit tests, so each one gets its own bucket.
 *
 * The limiter is keyed on IP + email and Supertest reuses the loopback address
 * for every request. Without a dedicated address, a test that deliberately trips
 * the limiter would leave the bucket exhausted for whatever runs next -- a flake
 * that looks exactly like a broken limiter.
 */
export const TEST_IPS = Object.freeze([
  '203.0.113.10',
  '203.0.113.11',
  '203.0.113.12',
  '203.0.113.13',
  '198.51.100.20',
  '198.51.100.21',
  '198.51.100.22',
  '198.51.100.23',
]);

/**
 * A client whose requests appear to originate from `ip`.
 *
 * `X-Forwarded-For` is honoured because src/app.js sets `trust proxy` -- the same
 * mechanism a real deployment behind Vercel or Render uses to make per-IP
 * limiting meaningful in the first place.
 */
export function createClientFromIp(app, ip) {
  const client = createClient(app);
  const asIp = (options) => ({
    ...options,
    headers: { 'x-forwarded-for': ip, ...(options?.headers ?? {}) },
  });

  return {
    get: (path, options) => client.get(path, asIp(options)),
    post: (path, body, options) => client.post(path, body, asIp(options)),
    patch: (path, body, options) => client.patch(path, body, asIp(options)),
    delete: (path, options) => client.delete(path, asIp(options)),

    async login(email, password) {
      const response = await client.post('/api/auth/login', { email, password }, asIp({}));
      if (response.status === 200 && response.body?.token) client.useBearer(response.body.token);
      return response;
    },

    useCookieSession: () => client.useCookieSession(),
    useBearer: (token) => client.useBearer(token),
    clearAuth: () => client.clearAuth(),

    get cookies() {
      return client.cookies;
    },
  };
}
