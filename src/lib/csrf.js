/**
 * CSRF defence for cookie-authenticated requests.
 *
 * The access token lives in an HttpOnly cookie, which the browser attaches to
 * cross-site requests automatically. Without protection, any site could POST
 * /api/orders on a logged-in user's behalf with no way for the user to notice.
 *
 * Double-submit pattern: a second, deliberately readable cookie (`sp_csrf`)
 * holds a random value that the frontend must echo back in the `X-CSRF-Token`
 * header. A cross-origin attacker can trigger the request but cannot read the
 * cookie to populate the header.
 *
 * Requests authenticated with `Authorization: Bearer` are exempt: they are not
 * attached ambiently by a browser, so they carry no CSRF risk (this is what
 * makes Postman and CI clients work without ceremony).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../errors/AppError.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function generateCsrfToken() {
  return randomBytes(32).toString('hex');
}

export function csrfCookieOptions() {
  return {
    httpOnly: false, // intentionally readable: the SPA must echo it back
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    path: '/',
  };
}

function equals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Called from the authentication middleware, immediately after it establishes
 * that the caller was authenticated via cookie. Binding the check to that exact
 * moment makes it impossible for a new route to forget the protection.
 */
export function assertCsrf(req) {
  if (SAFE_METHODS.has(req.method)) return;

  const cookieToken = req.cookies?.[env.CSRF_COOKIE_NAME];
  const headerToken = req.get('x-csrf-token');

  if (!equals(cookieToken, headerToken)) {
    throw AppError.forbidden(
      'Missing or invalid CSRF token. Send the sp_csrf cookie value in the X-CSRF-Token header.',
      'CSRF_FAILED',
    );
  }
}