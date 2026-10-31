/**
 * Administration routes (/api/admin).
 *
 * This router exists to make one security decision impossible to get wrong:
 * EVERY route under /api/admin requires an authenticated session whose role,
 * re-read from the database on this request, is exactly "Admin".
 *
 * Why a dedicated router instead of per-route guards:
 *
 *   - The guard is `router.use(...)`, so it runs before any handler. A new route
 *     added below is protected by construction; there is no per-route decorator
 *     to forget. That failure mode -- a new admin endpoint shipped without its
 *     role check -- is the single most common way RBAC breaks.
 *   - Path-based protection is auditable: "is /api/admin/* Admin-only?" is
 *     answered by reading seven lines, not by tracing every route file.
 *
 * Order matters: `authenticate` first (401 if there is no valid session), then
 * `requireRole(Admin)` (403 if the session is valid but the role is not). Getting
 * that backwards would answer 403 to anonymous callers and leak which paths
 * exist.
 */
import { Router } from 'express';

import { ROLES } from '../../config/env.js';
import { idParam } from '../../lib/commonSchemas.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as analytics from '../analytics/analytics.service.js';
import * as authService from '../auth/auth.service.js';
import { listUsersQuery } from '../auth/auth.schemas.js';

export const adminRouter = Router();

// ---------------------------------------------------------------------------
// The gate. Everything after this line is Admin-only.
// ---------------------------------------------------------------------------
adminRouter.use(authenticate, requireRole(ROLES.ADMIN));

/**
 * The platform-wide overview.
 *
 * `scope: { all: true }` is passed explicitly rather than being read from the
 * caller: this endpoint is defined as "whole organisation", and relying on the
 * caller's scope would silently change its meaning if the scope model ever grew
 * a narrower admin tier.
 */
adminRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const summary = await analytics.summary({ scope: { all: true, ids: null } });
    res.json({
      data: {
        ...summary,
        generated_at: new Date().toISOString(),
        requested_by: { id: req.user.id, email: req.user.email, role: req.user.role },
      },
    });
  }),
);

/** User administration. Same data as /api/users, under the audited prefix. */
adminRouter.get(
  '/users',
  validate({ query: listUsersQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.validatedQuery;
    const { rows, total } = await authService.listUsers({ limit, offset: (page - 1) * limit });
    res.json({ data: rows, meta: { page, limit, total } });
  }),
);

/**
 * Scoped user detail.
 *
 * Deliberately returns only the fields an administrator needs; a handler that
 * spreads a database row is how password hashes end up in a response body.
 */
adminRouter.get(
  '/users/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const profile = await authService.getProfile(req.params.id);
    res.json({
      data: {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        role: profile.role,
        is_active: profile.is_active,
        warehouses: profile.warehouses,
      },
    });
  }),
);
