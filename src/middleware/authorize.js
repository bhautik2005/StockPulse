/**
 * Authorisation middleware: role gates and warehouse scoping.
 *
 * Two independent questions must both be answered before any warehouse data is
 * returned:
 *
 *   1. Is this role allowed to perform this *kind* of action?  -> requireRole
 *   2. Is this specific record inside the caller's scope?       -> warehouseScope
 *
 * Skipping question 2 is the classic IDOR bug: a Manager who legitimately holds
 * the "view inventory" permission reads /api/warehouses/7/inventory for a
 * warehouse they have nothing to do with.
 */
import { query } from '../db/pool.js';
import { ROLES } from '../config/env.js';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from './asyncHandler.js';

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(
        AppError.forbidden(`This action requires one of: ${roles.join(', ')}`, 'INSUFFICIENT_ROLE'),
      );
    }
    return next();
  };
}

/**
 * Resolves the set of warehouses the caller may touch and stores it on the
 * request as `req.warehouseScope`.
 *
 *   Admin            -> { all: true }            every warehouse
 *   Manager / Staff  -> { all: false, ids: [] }  only explicitly granted ones
 *   Client           -> { all: false, ids: [] }  never any
 *
 * The scope is data, not a boolean, so it can be pushed straight into SQL and
 * the database does the filtering. Nothing is filtered in JavaScript after
 * being fetched, which is the pattern that leaks data under a missed code path.
 */
export const attachWarehouseScope = asyncHandler(async (req, _res, next) => {
  const user = req.user;
  if (!user) throw AppError.unauthorized();

  if (user.role === ROLES.ADMIN) {
    req.warehouseScope = { all: true, ids: null };
    return next();
  }

  const { rows } = await query(
    `SELECT w.id
       FROM warehouses w
      WHERE w.deleted_at IS NULL
        AND (
              w.manager_id = $1
              OR EXISTS (
                   SELECT 1 FROM user_warehouses uw
                    WHERE uw.warehouse_id = w.id AND uw.user_id = $1
                 )
            )
      ORDER BY w.id`,
    [user.id],
  );

  req.warehouseScope = { all: false, ids: rows.map((r) => r.id) };
  next();
});

/**
 * Route-level guard for endpoints where the warehouse is part of the URL.
 * `getWarehouseId` extracts the id from params, body or query.
 */
export function requireWarehouseAccess(getWarehouseId) {
  return (req, _res, next) => {
    const warehouseId = Number(getWarehouseId(req));

    if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
      return next(AppError.badRequest('warehouseId must be a positive integer'));
    }

    const scope = req.warehouseScope;
    if (!scope) return next(AppError.unauthorized());
    if (scope.all) {
      req.warehouseId = warehouseId;
      return next();
    }
    if (!scope.ids.includes(warehouseId)) {
      return next(
        AppError.forbidden('You do not have access to this warehouse', 'WAREHOUSE_FORBIDDEN'),
      );
    }

    req.warehouseId = warehouseId;
    return next();
  };
}