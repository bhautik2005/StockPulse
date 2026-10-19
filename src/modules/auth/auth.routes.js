/**
 * Authentication routes (/api/auth) and user administration (/api/users).
 */
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
  listUsersQuery,
  loginSchema,
  registerSchema,
  updateUserSchema,
  warehouseAccessSchema,
} from './auth.schemas.js';

export const authRouter = Router();
export const usersRouter = Router();

/**
 * Credential stuffing / brute force protection.
 *
 * Disabled under NODE_ENV=test so the suite can sign in freely; it is active in
 * development and production.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.isTest,
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
    res.json({ data: { ...profile, scope: req.warehouseScope } });
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