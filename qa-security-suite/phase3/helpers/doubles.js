/**
 * Phase 3 :: test doubles.
 *
 * The frontend is tested against STUBS of the API layer, never a live server.
 * Two rules keep that honest:
 *
 *   1. Failures are real `ApiError` instances (from src/services/api.js), not
 *      plain objects shaped like one. `describeError` and `isConflictError`
 *      inspect `status`/`code` getters, so a hand-rolled object could pass while
 *      the production error class would not. Using the real class means these
 *      tests exercise the same code path a 409 from Supabase would take.
 *
 *   2. A stub records HOW it was called. "The form did not submit" has to be
 *      proven by asserting the API was never asked, not by observing that an
 *      earlier assertion happened to pass.
 */
import { vi } from 'vitest';

import { ApiError } from '../../../client/src/services/api.js';

/**
 * Builds the stubbed `authApi` used by AuthContext.
 *
 * `me` is what AuthProvider calls on mount. Defaulting it to a 401 is not
 * laziness: for an unauthenticated visitor that is the *correct* answer from the
 * real server, and it is what lets login/register form tests render without a
 * signed-in redirect swallowing them.
 */
export function createAuthApiStub(overrides = {}) {
  return {
    login: vi.fn(),
    register: vi.fn(),
    me: vi.fn().mockRejectedValue(new ApiError(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } })),
    logout: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

/** A real ApiError, the way the transport layer would build one. */
export function apiError(status, { code, message, details } = {}) {
  return new ApiError(status, {
    error: {
      code: code ?? 'INTERNAL_ERROR',
      message: message ?? `Request failed with status ${status}`,
      ...(details === undefined ? {} : { details }),
    },
  });
}

/** The 401 a wrong password produces. */
export const invalidCredentials = () =>
  apiError(401, { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });

/** The 409 a duplicate registration produces. */
export const emailInUse = () =>
  apiError(409, { code: 'EMAIL_IN_USE', message: 'An account with this email already exists' });

/** The 429 a tripped login limiter produces. */
export const rateLimited = () =>
  apiError(429, { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again in a few minutes.' });

/** The 0 a dead network produces (fetch itself threw). */
export const networkFailure = () =>
  apiError(0, { code: 'NETWORK_ERROR', message: 'Cannot reach the server. Is the API running?' });

/** The 403 an insufficient role produces. */
export const insufficientRole = () =>
  apiError(403, { code: 'INSUFFICIENT_ROLE', message: 'This action requires one of: Admin' });

/** A successful profile, as GET /api/auth/me returns one. */
export function profile(overrides = {}) {
  return {
    id: 7,
    name: 'Ada Lovelace',
    email: 'ada@acme.test',
    role: 'Client',
    is_active: true,
    warehouses: [],
    scope: { all: false, ids: [] },
    ...overrides,
  };
}

/** Resolves a successful login the way AuthContext expects to consume it. */
export function successfulLogin(authApi, user = profile()) {
  authApi.login.mockResolvedValue({ data: user, token: 'stub.jwt.token' });
  authApi.me.mockResolvedValue({ data: user });
  return user;
}

/** Resolves a successful registration + automatic sign-in. */
export function successfulRegister(authApi, user = profile()) {
  authApi.register.mockResolvedValue({ data: user });
  authApi.login.mockResolvedValue({ data: user, token: 'stub.jwt.token' });
  authApi.me.mockResolvedValue({ data: user });
  return user;
}
