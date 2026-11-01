/**
 * Authentication routes (/api/auth) and user administration (/api/users).
 */
import { createHash } from 'node:crypto';

import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { env, ROLES } from '../../config/env.js';
import { idParam } from '../../lib/commonSchemas.js';
import { csrfCookieOptions, generateCsrfToken } from '../../lib/csrf.js';
import { authCookieOptions } from '../../lib/tokens.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { attachWarehouseScope, requireRole } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as service from './auth.service.js';
import {
  createUserSchema,
  forgotPasswordSchema,
  listUsersQuery,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateUserSchema,
  validateResetTokenSchema,
  warehouseAccessSchema,
} from './auth.schemas.js';

export const authRouter = Router();
export const usersRouter = Router();

/**
 * Credential stuffing / brute force protection.
 *
 * Exported as a factory for three reasons:
 *
 *  1. The counter store belongs to the limiter instance. Building a fresh one in
 *     a test starts its counters at zero, so the 429 path can be proven without
 *     waiting for a window to expire or burning the real limiter's budget.
 *  2. `skip` is driven by configuration (RATE_LIMIT_ENABLED), not by a
 *     hard-coded NODE_ENV check, so "is brute-force protection on?" becomes a
 *     deployment decision that a test can verify.
 *  3. A limiter no test ever executes is indistinguishable from one that does
 *     not work.
 *
 * Keyed by IP + email. Keying on IP alone lets an attacker behind a botnet spray
 * one password across many accounts; keying on the account alone lets a single
 * host lock a legitimate user out.
 */
export function createLoginLimiter({
  windowMs = env.RATE_LIMIT_WINDOW_MS,
  max = env.RATE_LIMIT_MAX,
  enabled = env.isRateLimitEnabled,
} = {}) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !enabled,
    keyGenerator: (req) => {
      const raw = req.ip ?? '';
      // Collapse IPv6 to its /56 network: without this a single client holds
      // thousands of distinct keys and the limit means nothing.
      const ip = raw.includes(':') ? raw.split(':').slice(0, 4).join(':') : raw;
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : 'anonymous';
      return `${ip}:${email}`;
    },
    handler: (req, res) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many sign-in attempts. Try again in a few minutes.',
          requestId: req.id,
        },
      });
    },
  });
}

const loginLimiter = createLoginLimiter();

// ---------------------------------------------------------------------------
// Password reset throttles
// ---------------------------------------------------------------------------

/**
 * Two independent buckets, because they stop different attacks:
 *
 *   - per IP:      5 requests / 15 min -> one host hammering the endpoint
 *   - per account: 3 requests /  1 hour -> a botnet aimed at one mailbox
 *
 * The account bucket is keyed on the *hash* of the normalised email. A limiter
 * store holds its keys in memory, where they can end up in a heap dump or a
 * debug log; storing a truncated SHA-256 means that artefact cannot be read as
 * a list of which addresses have accounts -- the same property the generic
 * response is protecting.
 */
function hashEmailKey(email) {
  return createHash('sha256').update(email).digest('hex').slice(0, 16);
}

/** Same IPv6 collapse as the login limiter, for the same reason. */
function ipKey(req) {
  const raw = req.ip ?? '';
  return raw.includes(':') ? raw.split(':').slice(0, 4).join(':') : raw;
}

function rejectRateLimited(req, res, message) {
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message, requestId: req.id },
  });
}

function limiterOptions({ windowMs, max, enabled }) {
  return {
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !enabled,
  };
}

export function createForgotPasswordLimiter({
  windowMs = env.RESET_RATE_IP_WINDOW_MS,
  max = env.RESET_RATE_IP_MAX,
  enabled = env.isRateLimitEnabled,
} = {}) {
  return rateLimit({
    ...limiterOptions({ windowMs, max, enabled }),
    keyGenerator: (req) => ipKey(req),
    handler: (req, res) =>
      rejectRateLimited(req, res, 'Too many reset requests from this address. Try again later.'),
  });
}

export function createForgotPasswordAccountLimiter({
  windowMs = env.RESET_RATE_ACCOUNT_WINDOW_MS,
  max = env.RESET_RATE_ACCOUNT_MAX,
  enabled = env.isRateLimitEnabled,
} = {}) {
  return rateLimit({
    ...limiterOptions({ windowMs, max, enabled }),
    keyGenerator: (req) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      // Fall back to the IP when the body has no email: an unkeyable request
      // must still be counted against something rather than bypass the limiter.
      return email ? `acct:${hashEmailKey(email)}` : `ip:${ipKey(req)}`;
    },
    handler: (req, res) =>
      rejectRateLimited(req, res, 'Too many reset requests for this account. Try again later.'),
  });
}

export function createResetAttemptLimiter({
  windowMs = env.RATE_LIMIT_WINDOW_MS,
  max = 20,
  enabled = env.isRateLimitEnabled,
} = {}) {
  return rateLimit({
    ...limiterOptions({ windowMs, max, enabled }),
    keyGenerator: (req) => ipKey(req),
    handler: (req, res) =>
      rejectRateLimited(req, res, 'Too many attempts. Try again in a few minutes.'),
  });
}

const forgotPasswordLimiter = createForgotPasswordLimiter();
const forgotPasswordAccountLimiter = createForgotPasswordAccountLimiter();
const resetAttemptLimiter = createResetAttemptLimiter();

/** Public sign-up. Always creates a Client; internal roles need an Admin. */
authRouter.post(
  '/register',
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const user = await service.register(req.body);
    res.status(201).json({ data: user });
  }),
);

/**
 * Sign in.
 *
 * Sets two cookies:
 *   sp_token  - HttpOnly, the session. Browser JavaScript cannot read it, so an
 *               XSS bug cannot exfiltrate the session.
 *   sp_csrf   - readable, echoed back in X-CSRF-Token on state-changing calls.
 *
 * The token is also returned in the body purely so non-browser clients (Postman,
 * CI) can use `Authorization: Bearer`. The SPA is expected to ignore it.
 */
authRouter.post(
  '/login',
  loginLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { user, token } = await service.login(req.body);
    const csrfToken = generateCsrfToken();

    res.cookie(env.COOKIE_NAME, token, authCookieOptions());
    res.cookie(env.CSRF_COOKIE_NAME, csrfToken, csrfCookieOptions());

    res.json({
      data: user,
      token,
      meta: { csrf_token: csrfToken },
    });
  }),
);

/**
 * Requests a password-reset link.
 *
 * Public, and deliberately answers 200 with one constant body for every
 * input -- an unknown address, a disabled account and a real one are
 * indistinguishable. The three mechanisms that keep that promise (equal token
 * work, non-blocking email, constant reply) live in the service.
 */
authRouter.post(
  '/forgot-password',
  forgotPasswordLimiter,
  forgotPasswordAccountLimiter,
  validate({ body: forgotPasswordSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.requestPasswordReset({ email: req.body.email });
    res.json(result);
  }),
);

/**
 * Reports whether a reset link is still usable, without spending it.
 *
 * Never 404s on a bad token: the answer is { valid: false }, which is both the
 * honest reply and one that cannot be used to distinguish "expired" from
 * "never existed" from "malformed".
 */
authRouter.post(
  '/validate-reset-token',
  resetAttemptLimiter,
  validate({ body: validateResetTokenSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.validateResetToken({ token: req.body.token });
    res.json(result);
  }),
);

/**
 * Spends a reset link and sets a new password.
 *
 * Sets no cookie and returns no token: the caller signs in afterwards. That is
 * what keeps a reset from doubling as an authentication bypass for anyone
 * holding the link.
 */
authRouter.post(
  '/reset-password',
  resetAttemptLimiter,
  validate({ body: resetPasswordSchema }),
  asyncHandler(async (req, res) => {
    const user = await service.resetPassword({
      token: req.body.token,
      password: req.body.password,
    });
    res.json({
      message: 'Your password has been reset. You can now sign in with your new password.',
      data: user,
    });
  }),
);

/** Ends the session. `?all=true` revokes every token issued to this account. */
authRouter.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.query.all === 'true') {
      await service.revokeSessions(req.user.id);
    }
    res.clearCookie(env.COOKIE_NAME, { ...authCookieOptions(), maxAge: undefined });
    res.clearCookie(env.CSRF_COOKIE_NAME, csrfCookieOptions());
    res.status(204).end();
  }),
);

/** Current identity plus the warehouses this account may act on. */
authRouter.get(
  '/me',
  authenticate,
  attachWarehouseScope,
  asyncHandler(async (req, res) => {
    const profile = await service.getProfile(req.user.id);
    res.json({
      data: { ...profile, scope: req.warehouseScope },
      meta: { csrf_token: req.cookies?.[env.CSRF_COOKIE_NAME] ?? null },
    });
  }),
);

// ---------------------------------------------------------------------------
// /api/users -- Admin only
// ---------------------------------------------------------------------------

usersRouter.use(authenticate, requireRole(ROLES.ADMIN));

usersRouter.get(
  '/',
  validate({ query: listUsersQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.validatedQuery;
    const { rows, total } = await service.listUsers({ limit, offset: (page - 1) * limit });
    res.json({ data: rows, meta: { page, limit, total } });
  }),
);

/** Creates an Admin, Manager, Staff or Client account. */
usersRouter.post(
  '/',
  validate({ body: createUserSchema }),
  asyncHandler(async (req, res) => {
    const user = await service.createUser({ actor: req.user, input: req.body });
    res.status(201).json({ data: user });
  }),
);

/**
 * Updates a user. Changing a role or disabling an account immediately revokes
 * that user's existing sessions.
 */
usersRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateUserSchema }),
  asyncHandler(async (req, res) => {
    const user = await service.updateUser({
      actor: req.user,
      userId: req.params.id,
      patch: req.body,
    });
    res.json({ data: user });
  }),
);

/** Grants or revokes warehouse access -- the basis of all RBAC scoping. */
usersRouter.post(
  '/:id/warehouse-access',
  validate({ params: idParam, body: warehouseAccessSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.setWarehouseAccess({
      actor: req.user,
      userId: req.params.id,
      grant: req.body.grant,
      revoke: req.body.revoke,
    });
    res.json({ data: result });
  }),
);

/**
 * Permanently deletes a deactivated Client or Manager.
 *
 * Admin-only (enforced by the router guard above). Administrators, active
 * accounts, Staff accounts and the caller's own account are all refused by the
 * service, so the rules hold even when the request does not come from the UI.
 */
usersRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const user = await service.deleteUser({ actor: req.user, userId: req.params.id });
    res.json({ data: user });
  }),
);