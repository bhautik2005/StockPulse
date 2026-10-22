/**
 * The single HTTP entry point.
 *
 * Three things here are not incidental:
 *
 *  1. `credentials: 'include'` -- the session lives in an HttpOnly cookie, so
 *     every request must carry it. Nothing is kept in localStorage: a token
 *     readable by JavaScript is a token any XSS can exfiltrate, and the whole
 *     point of the HttpOnly cookie is that it cannot be read.
 *
 *  2. `X-CSRF-Token` on writes -- the server protects cookie-authenticated
 *     mutations with a double-submit token. Cross-origin clients keep the value
 *     from login or `/me` in memory because they cannot read the API host's
 *     cookie; same-origin clients can fall back to reading that cookie.
 *
 *  3. Errors keep their machine-readable `code` and `details`. A 409
 *     INSUFFICIENT_STOCK carries per-line numbers, which is what lets the UI say
 *     "line 2: only 1 available" instead of "something went wrong".
 */
import { toQuery } from '../lib/utils.js';

const BASE_URL = import.meta.env.VITE_API_URL ?? '';
const CSRF_COOKIE = import.meta.env.VITE_CSRF_COOKIE ?? 'sp_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

/** Endpoints where a 401 means "not signed in", not "your session ended". */
const SILENT_401 = ['/api/auth/login', '/api/auth/me', '/api/auth/register'];

export class ApiError extends Error {
  constructor(status, payload) {
    const error = payload?.error ?? {};
    super(error.message || `Request failed (HTTP ${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = error.code || 'INTERNAL_ERROR';
    this.details = error.details;
    this.requestId = error.requestId;
  }

  /** True when the caller was authenticated but not permitted. */
  get isForbidden() {
    return this.status === 403;
  }

  get isConflict() {
    return this.status === 409;
  }

  get isValidation() {
    return this.status === 422 || this.code === 'VALIDATION_FAILED';
  }

  /** Per-line stock shortfalls from an INSUFFICIENT_STOCK rejection. */
  get stockConflicts() {
    return Array.isArray(this.details?.lines) ? this.details.lines : [];
  }

  /** Field-level messages from a validation failure, as { path: message }. */
  get fieldErrors() {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries(this.details.map((issue) => [issue.path, issue.message]));
  }
}

let onUnauthorized = null;
let csrfToken = null;

/**
 * Lets the auth layer react to an expired or revoked session without every
 * caller having to check for it.
 */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

export function readCookie(name) {
  const match = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

async function parse(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function request(method, path, { body, query, headers = {}, idempotencyKey } = {}) {
  const finalHeaders = { ...headers };

  if (body !== undefined && !(body instanceof FormData)) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = csrfToken ?? readCookie(CSRF_COOKIE);
    if (csrf) finalHeaders[CSRF_HEADER] = csrf;
  }

  if (idempotencyKey) finalHeaders['Idempotency-Key'] = idempotencyKey;

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}${toQuery(query)}`, {
      method,
      headers: finalHeaders,
      credentials: 'include',
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch (cause) {
    // A network failure is not an API error: the request never arrived.
    const error = new ApiError(0, {
      error: {
        code: 'NETWORK_ERROR',
        message: 'Cannot reach the server. Is the API running?',
      },
    });
    error.cause = cause;
    throw error;
  }

  const payload = await parse(response);
  if (typeof payload?.meta?.csrf_token === 'string') {
    csrfToken = payload.meta.csrf_token;
  }

  if (!response.ok) {
    const error = new ApiError(response.status, payload);
    if (response.status === 401) csrfToken = null;
    if (response.status === 401 && !SILENT_401.some((prefix) => path.startsWith(prefix))) {
      onUnauthorized?.(error);
    }
    throw error;
  }

  if (response.status === 204 && path.startsWith('/api/auth/logout')) csrfToken = null;
  return payload;
}

export const api = {
  get: (path, options) => request('GET', path, options),
  post: (path, body, options) => request('POST', path, { ...options, body }),
  patch: (path, body, options) => request('PATCH', path, { ...options, body }),
  delete: (path, options) => request('DELETE', path, options),
};