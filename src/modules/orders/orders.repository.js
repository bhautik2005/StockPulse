/**
 * Order persistence.
 *
 * Every function takes an explicit `db` handle (a pooled client inside a
 * transaction) rather than reaching for the global pool. That is what makes the
 * whole order path atomic: the reads that decide *whether* stock exists and the
 * write that consumes it happen on one connection, inside one transaction, with
 * nothing else able to interleave.
 *
 * Array parameter convention -- every `lines` argument is passed as three
 * parallel arrays with a fixed order:
 *
 *     $n  => product_id   (int[])
 *     $n+1 => warehouse_id (int[])
 *     $n+2 => qty          (int[])
 *
 * Keeping the order identical everywhere removes an entire class of silent
 * "decremented the wrong product" bugs.
 */
import { warehouseScopeClause } from '../../lib/warehouseScope.js';

/** @typedef {{ product_id: number, warehouse_id: number, qty: number }} Line */

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function findByIdempotencyKey(db, key) {
  return db.query('SELECT id FROM orders WHERE idempotency_key = $1', [key]);
}

/**
 * Locks the product rows for the duration of the transaction.
 *
 * FOR SHARE (not FOR UPDATE) because an order only needs the *price and name* to
 * stay stable -- it must not block other customers buying the same product. Any
 * concurrent price edit blocks until this order commits, which is what prevents
 * a customer being charged a price they never saw.
 */
export function lockProductsForOrder(db, productIds) {
  return db.query(
    `SELECT id, sku, name, unit_price, is_active, deleted_at
       FROM products
      WHERE id = ANY($1::int[])
      ORDER BY id
        FOR SHARE`,
    [productIds],
  );
}

export function findActiveWarehouses(db, warehouseIds) {
  return db.query(
    `SELECT id, code, name
       FROM warehouses
      WHERE id = ANY($1::int[])
        AND is_active
        AND deleted_at IS NULL
      ORDER BY id`,
    [warehouseIds],
  );
}

/**
 * Stock candidates used for automatic warehouse allocation, best first:
 * most stock, then lowest warehouse id (a stable tie-break keeps allocation
 * deterministic and therefore testable).
 */
export function findStockCandidates(db, productIds, scope) {
  const params = [productIds];
  const scopeClause = scope === undefined ? 'TRUE' : warehouseScopeClause(scope, 'w.id', params);

  return db.query(
    `SELECT i.product_id, i.warehouse_id, i.quantity
       FROM inventory i
       JOIN warehouses w ON w.id = i.warehouse_id
      WHERE i.product_id = ANY($1::int[])
        AND ${scopeClause}
        AND w.is_active
        AND w.deleted_at IS NULL
        AND (SELECT is_active FROM products WHERE id = i.product_id) = true
      ORDER BY i.product_id, i.quantity DESC, i.warehouse_id ASC`,
    params,
  );
}

/**
 * Acquires row locks in a deterministic order *before* mutating anything.
 *
 * Two orders that touch products {1,2} and {2,1} would otherwise be able to
 * deadlock: each holds the lock the other needs. Sorting by product_id and then
 * warehouse_id means every transaction walks the same sequence, so one simply
 * waits for the other. PostgreSQL's LockRows node sits above the Sort node, so
 * rows are locked in the sorted order shown here.
 */
export function lockInventoryRows(db, lines) {
  return db.query(
    `SELECT i.product_id, i.warehouse_id, i.quantity
       FROM inventory i
       JOIN (
              SELECT * FROM unnest($1::int[], $2::int[]) AS t(product_id, warehouse_id)
            ) l
         ON l.product_id = i.product_id
        AND l.warehouse_id = i.warehouse_id
      ORDER BY i.product_id, i.warehouse_id
        FOR UPDATE OF i`,
    [lines.map((l) => l.product_id), lines.map((l) => l.warehouse_id)],
  );
}

/**
 * The single statement that makes overselling impossible.
 *
 * `AND i.quantity >= r.qty` is evaluated by the database against the row it is
 * about to modify. Under READ COMMITTED, if another transaction has already
 * committed a decrement, this statement waits on the row lock and then
 * *re-evaluates the predicate against the new value*. Either it updates (stock
 * was sufficient) or the row is skipped and `rowCount` comes up short -- there
 * is no window in which both orders can succeed.
 *
 * A read-then-write implementation ("SELECT quantity, check, then UPDATE")
 * cannot offer that guarantee at any isolation level below SERIALIZABLE.
 */
export function decrementInventory(db, lines) {
  return db.query(
    `WITH requested AS (
       SELECT * FROM unnest($1::int[], $2::int[], $3::int[]) AS t(product_id, warehouse_id, qty)
       ORDER BY product_id, warehouse_id
     )
     UPDATE inventory i
        SET quantity = i.quantity - r.qty
       FROM requested r
      WHERE i.product_id = r.product_id
        AND i.warehouse_id = r.warehouse_id
        AND i.quantity >= r.qty
     RETURNING i.product_id, i.warehouse_id, i.quantity AS remaining`,
    [lines.map((l) => l.product_id), lines.map((l) => l.warehouse_id), lines.map((l) => l.qty)],
  );
}

/** Availability snapshot used to build a genuinely helpful 409 response. */
export function inspectAvailability(db, lines) {
  return db.query(
    `SELECT l.product_id,
            l.warehouse_id,
            COALESCE(i.quantity, 0) AS available
       FROM unnest($1::int[], $2::int[]) AS l(product_id, warehouse_id)
       LEFT JOIN inventory i
              ON i.product_id = l.product_id
             AND i.warehouse_id = l.warehouse_id`,
    [lines.map((l) => l.product_id), lines.map((l) => l.warehouse_id)],
  );
}

export function findOrderWithItems(db, orderId) {
  return db.query(
    `SELECT o.id, o.order_number, o.status, o.total_amount, o.currency,
            o.created_at, o.updated_at, o.cancelled_reason,
            o.idempotency_key,
            u.id AS client_id, u.name AS client_name, u.email AS client_email
       FROM orders o
       JOIN users u ON u.id = o.client_id
      WHERE o.id = $1`,
    [orderId],
  );
}

export function findOrderItems(db, orderId) {
  return db.query(
    `SELECT oi.id, oi.product_id, oi.warehouse_id,
            w.code AS warehouse_code, w.name AS warehouse_name,
            oi.product_sku, oi.product_name,
            oi.quantity, oi.price_at_purchase, oi.line_total
       FROM order_items oi
       JOIN warehouses w ON w.id = oi.warehouse_id
      WHERE oi.order_id = $1
      ORDER BY oi.id`,
    [orderId],
  );
}

export function findStatusHistory(db, orderId) {
  return db.query(
    `SELECT h.from_status, h.to_status, h.created_at, u.name AS changed_by_name
       FROM order_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.order_id = $1
      ORDER BY h.created_at, h.id`,
    [orderId],
  );
}

/**
 * Locks an order row for a state change. Any concurrent transition waits here,
 * so two operators cannot both ship and cancel the same order.
 */
export function lockOrderForUpdate(db, orderId) {
  return db.query(
    `SELECT id, order_number, client_id, status, total_amount, currency
       FROM orders
      WHERE id = $1
        FOR UPDATE`,
    [orderId],
  );
}

/** Line quantities needed to put stock back when an order is cancelled. */
export function findOrderLinesForRestock(db, orderId) {
  return db.query(
    `SELECT product_id, warehouse_id, quantity
       FROM order_items
      WHERE order_id = $1 AND product_id IS NOT NULL
      ORDER BY product_id, warehouse_id`,
    [orderId],
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Inserts the order header.
 *
 * `total_amount` is computed here, in SQL, from the requested quantities and the
 * *current* catalogue prices. It never comes from the request body: trusting a
 * client-supplied total is how systems end up selling at a price the customer
 * chose. NUMERIC arithmetic keeps it exact.
 */
export async function createOrder(db, { clientId, currency, idempotencyKey, lines }) {
  const { rows } = await db.query(
    `WITH priced AS (
       SELECT COALESCE(sum(ld.qty * p.unit_price), 0)::numeric(14,2) AS total
         FROM unnest($2::int[], $3::int[]) AS ld(product_id, qty)
         JOIN products p ON p.id = ld.product_id
     )
     INSERT INTO orders (order_number, client_id, status, total_amount, currency, idempotency_key)
     SELECT 'SO-' || to_char(now(), 'YYYY') || '-' ||
            lpad(nextval('order_number_seq')::text, 6, '0'),
            $1, 'Pending', priced.total, $4, $5
       FROM priced
     RETURNING id, order_number, status, total_amount, currency, created_at`,
    [
      clientId,
      lines.map((l) => l.product_id),
      lines.map((l) => l.qty),
      currency,
      idempotencyKey,
    ],
  );
  return rows[0];
}

/**
 * Inserts the order lines, snapshotting SKU, product name and unit price.
 *
 * The snapshot is what keeps history truthful: renaming or repricing a product
 * later changes the catalogue, never the record of what was sold.
 */
export async function insertOrderItems(db, orderId, lines) {
  const { rowCount } = await db.query(
    `INSERT INTO order_items
            (order_id, product_id, warehouse_id, product_sku, product_name, quantity, price_at_purchase)
     SELECT $1, ld.product_id, ld.warehouse_id, p.sku, p.name, ld.qty, p.unit_price
       FROM unnest($2::int[], $3::int[], $4::int[]) AS ld(product_id, warehouse_id, qty)
       JOIN products p ON p.id = ld.product_id`,
    [
      orderId,
      lines.map((l) => l.product_id),
      lines.map((l) => l.warehouse_id),
      lines.map((l) => l.qty),
    ],
  );
  return rowCount;
}

/**
 * Every stock movement is recorded in the same transaction as the movement
 * itself, so the ledger can never disagree with the quantity it explains.
 *
 * `direction` is not cosmetic. A sale removes stock (negative delta); a
 * cancellation returns it (positive delta). Signing both the same way would
 * leave the ledger summing to something other than the quantity on hand --
 * which is exactly the class of silent inconsistency the ledger exists to
 * prevent, so the sign is an explicit parameter rather than an assumption.
 */
export async function insertLedgerEntries(db, {
  orderId,
  lines,
  actorId,
  reason = 'sale',
  direction = 'out',
}) {
  const sign = direction === 'in' ? 1 : -1;

  const { rowCount } = await db.query(
    `INSERT INTO inventory_transactions
            (warehouse_id, product_id, delta, reason, ref_type, ref_id, created_by)
     SELECT ld.warehouse_id, ld.product_id, ld.qty * $7::int, $5, 'order', $4, $6
       FROM unnest($1::int[], $2::int[], $3::int[]) AS ld(product_id, warehouse_id, qty)`,
    [
      lines.map((l) => l.product_id),
      lines.map((l) => l.warehouse_id),
      lines.map((l) => l.qty),
      orderId,
      reason,
      actorId ?? null,
      sign,
    ],
  );
  return rowCount;
}

/** Puts stock back. Returns the number of inventory rows actually touched. */
export async function restockInventory(db, lines) {
  const { rowCount } = await db.query(
    `UPDATE inventory i
        SET quantity = i.quantity + r.qty
       FROM unnest($1::int[], $2::int[], $3::int[]) AS r(product_id, warehouse_id, qty)
      WHERE i.product_id = r.product_id
        AND i.warehouse_id = r.warehouse_id`,
    [lines.map((l) => l.product_id), lines.map((l) => l.warehouse_id), lines.map((l) => l.qty)],
  );
  return rowCount;
}

export function insertStatusHistory(db, { orderId, from, to, changedBy }) {
  return db.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by)
     VALUES ($1, $2, $3, $4)`,
    [orderId, from, to, changedBy ?? null],
  );
}

export function updateOrderStatus(db, { orderId, status, cancelledReason = null }) {
  // The casts are not decoration: $2 appears both as the value for
  // `status` (varchar) and inside a comparison (which PostgreSQL would infer as
  // text). Without an explicit type the planner fails with
  // "inconsistent types deduced for parameter $2" (SQLSTATE 42P08).
  return db.query(
    `UPDATE orders
        SET status = $2::varchar(30),
            cancelled_reason = CASE
                                 WHEN $2::varchar(30) = 'Cancelled' THEN $3::text
                                 ELSE cancelled_reason
                               END
      WHERE id = $1
      RETURNING id, order_number, status, total_amount, currency, cancelled_reason, updated_at`,
    [orderId, status, cancelledReason],
  );
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * Builds the visibility predicate for an order listing.
 *
 *   Client          -> only their own orders
 *   Manager / Staff -> only orders that have at least one line they control
 *   Admin           -> everything
 *
 * The predicate is SQL, not JavaScript filtering, so an out-of-scope order is
 * never read out of the database in the first place.
 */
function orderVisibilityClause({ scope, clientId }, params) {
  const clauses = [];

  if (clientId !== undefined && clientId !== null) {
    params.push(clientId);
    clauses.push(`o.client_id = $${params.length}`);
  }
  if (scope && !scope.all) {
    if (!scope.ids || scope.ids.length === 0) {
      return 'FALSE';
    }
    params.push(scope.ids);
    clauses.push(
      `EXISTS (SELECT 1 FROM order_items vis
                WHERE vis.order_id = o.id
                  AND vis.warehouse_id = ANY($${params.length}::int[]))`,
    );
  }

  return clauses.length ? clauses.join(' AND ') : 'TRUE';
}

export async function listOrders(db, { scope, clientId, status, warehouseId, from, to, limit, offset }) {
  const params = [];
  const clauses = [orderVisibilityClause({ scope, clientId }, params)];
  const scopeParamIndex =
    scope && !scope.all ? params.findIndex((value) => value === scope.ids) + 1 : null;

  if (status) {
    params.push(status);
    clauses.push(`o.status = $${params.length}`);
  }
  if (warehouseId) {
    params.push(warehouseId);
    clauses.push(
      `EXISTS (SELECT 1 FROM order_items fw
                WHERE fw.order_id = o.id AND fw.warehouse_id = $${params.length})`,
    );
  }
  if (from) {
    params.push(from);
    clauses.push(`o.created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    clauses.push(`o.created_at <= $${params.length}`);
  }

  const where = clauses.join(' AND ');
  const scopedLineFilter = scopeParamIndex
    ? `oi.warehouse_id = ANY($${scopeParamIndex}::int[])`
    : null;
  const totalAmount = scopedLineFilter
    ? `COALESCE(sum(oi.line_total) FILTER (WHERE ${scopedLineFilter}), 0)::numeric(14,2)`
    : 'o.total_amount';
  const lineCount = scopedLineFilter
    ? `count(oi.id) FILTER (WHERE ${scopedLineFilter})::int`
    : 'count(oi.id)::int';

  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT o.id, o.order_number, o.status, ${totalAmount} AS total_amount, o.currency,
            o.created_at, u.name AS client_name,
            ${lineCount} AS line_count
       FROM orders o
       JOIN users u ON u.id = o.client_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE ${where}
      GROUP BY o.id, u.name
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const countParams = params.slice(0, params.length - 2);
  const { rows: countRows } = await db.query(
    `SELECT count(*)::int AS total FROM orders o WHERE ${where}`,
    countParams,
  );

  return { rows, total: countRows[0]?.total ?? 0 };
}