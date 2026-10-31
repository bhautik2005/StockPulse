/**
 * Inventory persistence.
 *
 * The scope predicate is always supplied by the caller and always applied in
 * SQL, so a Manager's query never reads another warehouse's rows at all.
 */
import { warehouseScopeClause } from '../../lib/warehouseScope.js';

export function listStock(db, { scope, warehouseId, productId, lowStock, search, limit, offset }) {
  const params = [];
  const clauses = [warehouseScopeClause(scope, 'i.warehouse_id', params), 'p.is_active = true', 'p.deleted_at IS NULL'];

  if (warehouseId) {
    params.push(warehouseId);
    clauses.push(`i.warehouse_id = $${params.length}`);
  }
  if (productId) {
    params.push(productId);
    clauses.push(`i.product_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(p.sku ILIKE $${params.length} OR p.name ILIKE $${params.length})`);
  }

  const lowStockExpression = 'i.quantity <= COALESCE(i.reorder_level, p.reorder_level)';
  if (lowStock === true) clauses.push(lowStockExpression);
  if (lowStock === false) clauses.push(`NOT (${lowStockExpression})`);

  const where = clauses.join(' AND ');

  params.push(limit, offset);
  return db.query(
    `SELECT i.id, i.warehouse_id,
            w.code AS warehouse_code, w.name AS warehouse_name,
            i.product_id, p.sku, p.name AS product_name, p.category,
            i.quantity,
            COALESCE(i.reorder_level, p.reorder_level) AS effective_reorder_level,
            p.unit_price,
            (i.quantity * p.unit_price)::numeric(14,2) AS stock_value
       FROM inventory i
       JOIN warehouses w ON w.id = i.warehouse_id
       JOIN products   p ON p.id = i.product_id
      WHERE ${where}
      ORDER BY p.name ASC, w.name ASC, i.product_id ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
}

export function countStock(db, { scope, warehouseId, productId, lowStock, search }) {
  const params = [];
  const clauses = [warehouseScopeClause(scope, 'i.warehouse_id', params), 'p.is_active = true', 'p.deleted_at IS NULL'];

  if (warehouseId) {
    params.push(warehouseId);
    clauses.push(`i.warehouse_id = $${params.length}`);
  }
  if (productId) {
    params.push(productId);
    clauses.push(`i.product_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(p.sku ILIKE $${params.length} OR p.name ILIKE $${params.length})`);
  }
  const lowStockExpression = 'i.quantity <= COALESCE(i.reorder_level, p.reorder_level)';
  if (lowStock === true) clauses.push(lowStockExpression);
  if (lowStock === false) clauses.push(`NOT (${lowStockExpression})`);

  return db.query(
    `SELECT count(*)::int AS total
       FROM inventory i
       JOIN warehouses w ON w.id = i.warehouse_id
       JOIN products   p ON p.id = i.product_id
      WHERE ${clauses.join(' AND ')}`,
    params,
  );
}

export function listLowStock(db, { scope, limit }) {
  const params = [];
  const clause = warehouseScopeClause(scope, 'warehouse_id', params);
  params.push(limit);

  /*
   * The `low_stock` view already excludes archived products and deleted
   * warehouses in its own definition. Repeating those predicates here was not
   * merely redundant: the view does not project `is_active` or `deleted_at`, so
   * referencing them made every call fail with
   * `column "is_active" does not exist` and a 500.
   */
  return db.query(
    `SELECT * FROM low_stock
      WHERE ${clause}
      ORDER BY units_below_threshold DESC, product_name ASC
      LIMIT $${params.length}`,
    params,
  );
}

export function findStockRow(db, { warehouseId, productId }) {
  return db.query(
    `SELECT quantity, reorder_level FROM inventory WHERE warehouse_id = $1 AND product_id = $2`,
    [warehouseId, productId],
  );
}

/**
 * Applies a signed delta, but only if the result stays non-negative.
 *
 * `AND quantity + $3 >= 0` is what turns "reduce stock" into a safe operation
 * under concurrency: the database decides, against the current row, whether the
 * adjustment is legal. A read-free zero-row result tells the caller the
 * adjustment was refused; it never silently clamps to zero.
 */
export function applyDelta(db, { warehouseId, productId, delta }) {
  return db.query(
    `UPDATE inventory
        SET quantity = quantity + $3
      WHERE warehouse_id = $1
        AND product_id = $2
        AND quantity + $3 >= 0
      RETURNING quantity, reorder_level`,
    [warehouseId, productId, delta],
  );
}

/** Creates the stock row for a first receipt. DO NOTHING handles a race. */
export function createStockRow(db, { warehouseId, productId, quantity }) {
  return db.query(
    `INSERT INTO inventory (warehouse_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (warehouse_id, product_id) DO NOTHING
     RETURNING quantity, reorder_level`,
    [warehouseId, productId, quantity],
  );
}

export function findWarehouse(db, warehouseId) {
  return db.query(
    `SELECT id, code, name FROM warehouses WHERE id = $1 AND deleted_at IS NULL AND is_active`,
    [warehouseId],
  );
}

export function findProduct(db, productId) {
  return db.query(
    `SELECT id, sku, name, unit_price FROM products WHERE id = $1 AND deleted_at IS NULL AND is_active`,
    [productId],
  );
}

export function insertLedger(db, { warehouseId, productId, delta, reason, note, actorId }) {
  return db.query(
    `INSERT INTO inventory_transactions (warehouse_id, product_id, delta, reason, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [warehouseId, productId, delta, reason, note ?? null, actorId ?? null],
  );
}

export function listLedger(db, { scope, warehouseId, productId, limit }) {
  const params = [];
  const clauses = [warehouseScopeClause(scope, 't.warehouse_id', params), 'p.is_active = true', 'p.deleted_at IS NULL'];

  if (warehouseId) {
    params.push(warehouseId);
    clauses.push(`t.warehouse_id = $${params.length}`);
  }
  if (productId) {
    params.push(productId);
    clauses.push(`t.product_id = $${params.length}`);
  }

  params.push(limit);
  return db.query(
    `SELECT t.id, t.delta, t.reason, t.ref_type, t.ref_id, t.note, t.created_at,
            t.warehouse_id, w.code AS warehouse_code,
            t.product_id, p.sku,
            u.name AS created_by_name
       FROM inventory_transactions t
       JOIN warehouses w ON w.id = t.warehouse_id
       JOIN products   p ON p.id = t.product_id
       LEFT JOIN users u ON u.id = t.created_by
      WHERE ${clauses.join(' AND ')}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $${params.length}`,
    params,
  );
}