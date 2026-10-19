/**
 * Warehouse management.
 *
 * SQL lives in the service here rather than a separate repository: these queries
 * are simple reads and writes with no subtle concurrency behaviour. Repositories
 * are reserved for the modules where the SQL *is* the business rule -- orders,
 * inventory and users.
 */
import { pool, query } from '../../db/pool.js';
import { ROLES } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';
import { assertWarehouseInScope, warehouseScopeClause } from '../../lib/warehouseScope.js';
import * as ordersRepo from '../orders/orders.repository.js';

function mapWarehouse(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    location: row.location,
    is_active: row.is_active,
    manager: row.manager_id
      ? { id: row.manager_id, name: row.manager_name, email: row.manager_email }
      : null,
    counts: {
      products: row.product_count ?? undefined,
      units_on_hand: row.units_on_hand ?? undefined,
    },
    created_at: row.created_at,
  };
}

/**
 * Lists warehouses inside the caller's scope.
 *
 * An empty scope yields `FALSE`, so a Staff member with no grants sees an empty
 * list rather than every warehouse in the company.
 */
export async function listWarehouses({ scope, includeInactive = false, limit, offset }) {
  const params = [];
  const clauses = [warehouseScopeClause(scope, 'w.id', params)];

  if (!includeInactive) clauses.push('w.is_active');
  clauses.push('w.deleted_at IS NULL');

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT w.id, w.code, w.name, w.location, w.is_active, w.created_at,
            w.manager_id, m.name AS manager_name, m.email AS manager_email,
            (SELECT count(*)::int FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.warehouse_id = w.id AND p.is_active = true AND p.deleted_at IS NULL) AS product_count,
            (SELECT COALESCE(sum(i.quantity), 0)::int FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.warehouse_id = w.id AND p.is_active = true AND p.deleted_at IS NULL) AS units_on_hand
       FROM warehouses w
       LEFT JOIN users m ON m.id = w.manager_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY w.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const countParams = params.slice(0, params.length - 2);
  const { rows: countRows } = await query(
    `SELECT count(*)::int AS total FROM warehouses w WHERE ${clauses.join(' AND ')}`,
    countParams,
  );

  return { rows: rows.map(mapWarehouse), total: countRows[0].total };
}

export async function getWarehouse({ scope, warehouseId }) {
  assertWarehouseInScope(scope, warehouseId);

  const { rows } = await query(
    `SELECT w.id, w.code, w.name, w.location, w.is_active, w.created_at,
            w.manager_id, m.name AS manager_name, m.email AS manager_email
       FROM warehouses w
       LEFT JOIN users m ON m.id = w.manager_id
      WHERE w.id = $1 AND w.deleted_at IS NULL`,
    [warehouseId],
  );

  if (rows.length === 0) throw AppError.notFound('Warehouse not found', 'WAREHOUSE_NOT_FOUND');
  return mapWarehouse(rows[0]);
}

/**
 * Validates a prospective manager.
 *
 * The database can enforce "this user exists" with a foreign key, but not "this
 * user is allowed to manage a warehouse" -- that is a business rule, so it is
 * checked here. The one-manager-per-warehouse rule is separately enforced by a
 * partial unique index.
 */
async function assertAssignableManager(db, managerId) {
  if (managerId === null || managerId === undefined) return;

  const { rows } = await db.query(
    `SELECT id, role, is_active FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [managerId],
  );
  const user = rows[0];

  if (!user) throw AppError.unprocessable('Manager account not found', 'MANAGER_NOT_FOUND', { manager_id: managerId });
  if (!user.is_active) {
    throw AppError.unprocessable('Manager account is disabled', 'MANAGER_INACTIVE', { manager_id: managerId });
  }
  if (user.role !== ROLES.MANAGER && user.role !== ROLES.ADMIN) {
    throw AppError.unprocessable('Only a Manager or Admin may be assigned as warehouse manager', 'MANAGER_ROLE_INVALID', {
      manager_id: managerId,
      role: user.role,
    });
  }
}

export async function createWarehouse({ input }) {
  await assertAssignableManager(pool, input.manager_id);

  try {
    const { rows } = await query(
      `INSERT INTO warehouses (code, name, location, manager_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, code, name, location, is_active, manager_id, created_at`,
      [input.code, input.name, input.location, input.manager_id ?? null],
    );

    // The assigned manager immediately gains scoped access to their warehouse.
    if (input.manager_id) {
      await query(
        `INSERT INTO user_warehouses (user_id, warehouse_id, granted_by)
         VALUES ($1, $2, $1) ON CONFLICT DO NOTHING`,
        [input.manager_id, rows[0].id],
      );
    }

    return mapWarehouse(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      throw AppError.conflict(
        'A warehouse with this code already exists, or this manager already owns one',
        'WAREHOUSE_CONFLICT',
        { constraint: error.constraint },
      );
    }
    throw error;
  }
}

export async function updateWarehouse({ warehouseId, patch }) {
  await assertAssignableManager(pool, patch.manager_id);

  try {
    const { rows } = await query(
      `UPDATE warehouses
          SET name = COALESCE($2, name),
              location = COALESCE($3, location),
              manager_id = CASE WHEN $4::boolean THEN $5 ELSE manager_id END,
              is_active = COALESCE($6, is_active)
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, code, name, location, is_active, manager_id, created_at`,
      [
        warehouseId,
        patch.name ?? null,
        patch.location ?? null,
        Object.prototype.hasOwnProperty.call(patch, 'manager_id'),
        patch.manager_id ?? null,
        patch.is_active ?? null,
      ],
    );

    if (rows.length === 0) throw AppError.notFound('Warehouse not found', 'WAREHOUSE_NOT_FOUND');

    if (patch.manager_id) {
      await query(
        `INSERT INTO user_warehouses (user_id, warehouse_id, granted_by)
         VALUES ($1, $2, $1) ON CONFLICT DO NOTHING`,
        [patch.manager_id, warehouseId],
      );
    }

    return mapWarehouse(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      throw AppError.conflict(
        'This manager is already accountable for another warehouse',
        'MANAGER_ALREADY_ASSIGNED',
        { constraint: error.constraint },
      );
    }
    throw error;
  }
}

/** Recent stock movements for one warehouse (used by the warehouse detail view). */
export async function listWarehouseLedger({ scope, warehouseId, limit = 50 }) {
  assertWarehouseInScope(scope, warehouseId);
  const { rows } = await query(
    `SELECT t.id, t.delta, t.reason, t.ref_type, t.ref_id, t.note, t.created_at,
            t.product_id, p.sku, p.name AS product_name,
            u.name AS created_by_name
       FROM inventory_transactions t
       JOIN products p ON p.id = t.product_id
       LEFT JOIN users u ON u.id = t.created_by
      WHERE t.warehouse_id = $1
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $2`,
    [warehouseId, limit],
  );
  return rows;
}

/**
 * Orders that have at least one line in this warehouse, so a Manager can work
 * their own fulfilment queue. Reuses the order repository's visibility rules.
 */
export async function listWarehouseOrders({ scope, warehouseId, limit = 20 }) {
  assertWarehouseInScope(scope, warehouseId);
  return ordersRepo.listOrders(pool, {
    scope,
    clientId: undefined,
    status: undefined,
    warehouseId,
    from: undefined,
    to: undefined,
    limit,
    offset: 0,
  });
}