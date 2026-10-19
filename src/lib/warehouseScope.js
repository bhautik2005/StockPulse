/**
 * Warehouse scope helpers.
 *
 * `scope` is the value produced by the attachWarehouseScope middleware:
 *   { all: true,  ids: null }  -> unrestricted (Admin)
 *   { all: false, ids: [1,3] } -> restricted to those warehouse ids
 *   { all: false, ids: [] }    -> no access at all
 *
 * Building SQL predicates from the scope (instead of filtering in JavaScript)
 * means an unauthorised row is never even transmitted from the database.
 */
import { AppError } from '../errors/AppError.js';

/** Throw unless `warehouseId` is inside the caller's scope. */
export function assertWarehouseInScope(scope, warehouseId) {
  if (scope?.all) return;
  if (!scope || !scope.ids?.includes(Number(warehouseId))) {
    throw AppError.forbidden('You do not have access to this warehouse', 'WAREHOUSE_FORBIDDEN');
  }
}

/** True when the scope grants nothing -- callers should short-circuit to []. */
export function isEmptyScope(scope) {
  return !scope?.all && (scope?.ids?.length ?? 0) === 0;
}

/**
 * Appends a scope predicate to a parameter list and returns the SQL fragment.
 *
 *   const params = [];
 *   const clause = warehouseScopeClause(req.warehouseScope, 'i.warehouse_id', params);
 *   // -> params = [[1,3]], clause = 'i.warehouse_id = ANY($1::int[])'
 *
 * An empty scope yields `FALSE`, so the query returns zero rows rather than
 * every row -- fail closed, never fail open.
 */
export function warehouseScopeClause(scope, column, params) {
  if (scope?.all) return 'TRUE';
  if (isEmptyScope(scope)) return 'FALSE';
  params.push(scope.ids);
  return `${column} = ANY($${params.length}::int[])`;
}