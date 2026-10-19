/**
 * Minimal HTTP client for the tests.
 *
 * Exists so the suite can exercise the real transport and the real security
 * layer: cookies with HttpOnly semantics, CSRF double-submit, Bearer auth and
 * status codes. Calling service functions directly would skip all of that.
 *
 * The cookie jar is deliberately explicit -- one client instance represents one
 * browser session, and a test can therefore hold two sessions at once (which is
 * how the IDOR tests prove that Manager A cannot read Manager B's warehouse).
 */
import { env } from './harness.js';

export function createApiClient(baseUrl) {
  const cookies = new Map();
  let bearerToken = null;

  function cookieHeader() {
    return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  function absorbSetCookies(response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const separator = pair.indexOf('=');
      if (separator === -1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();

      if (value === '') cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  async function request(method, path, options = {}) {
    const { body, query, headers = {}, omitCsrf = false, signal } = options;

    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const requestHeaders = { ...headers };
    const cookie = cookieHeader();
    if (cookie) requestHeaders.cookie = cookie;
    if (bearerToken) requestHeaders.authorization = `Bearer ${bearerToken}`;

    // Double-submit CSRF: echo the readable cookie, exactly as the SPA does.
    if (!omitCsrf && cookies.has(env.CSRF_COOKIE_NAME)) {
      requestHeaders['x-csrf-token'] = cookies.get(env.CSRF_COOKIE_NAME);
    }

    const init = { method, headers: requestHeaders, signal };
    if (body !== undefined) {
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        init.body = body;
      } else {
        requestHeaders['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }

    const response = await fetch(url, init);
    absorbSetCookies(response);

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    return { status: response.status, headers: response.headers, body: parsed };
  }

  const client = {
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    patch: (path, body, options) => request('PATCH', path, { ...options, body }),
    delete: (path, options) => request('DELETE', path, options),

    /** Signs in and keeps the returned cookies on this client. */
    async login(email, password) {
      const response = await request('POST', '/api/auth/login', { body: { email, password } });
      if (response.status === 200 && response.body?.token) {
        client.useBearer(response.body.token);
      }
      return response;
    },

    /** Switches to Authorization: Bearer, bypassing cookie-based CSRF checks. */
    useBearer(token) {
      bearerToken = token;
    },

    clearAuth() {
      bearerToken = null;
      cookies.clear();
    },

    get cookies() {
      return cookies;
    },
  };

  return client;
}

/** True when the response is the expected error code. */
export function isError(response, code) {
  return response.body?.error?.code === code;
}