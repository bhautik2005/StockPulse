/**
 * Order business logic.
 *
 * This module is where StockPulse's central promise is implemented: placing an
 * order either creates the order, writes its lines, consumes stock in the right
 * warehouse and records a ledger entry -- all of it, atomically -- or it changes
 * nothing at all and the client gets a 409 explaining exactly which line fell
 * short.
 *
 * Ordering of operations inside the transaction matters:
 *
 *   1. idempotency lookup        (a retry must not become a second order)
 *   2. product lock + validation (price cannot move under us)
 *   3. warehouse resolution      (explicit, or automatic allocation)
 *   4. inventory row locks       (deterministic order -> no deadlocks)
 *   5. order + line inserts      (rolled back wholesale if step 6 fails)
 *   6. conditional decrement     (the guard that makes overselling impossible)
 *   7. ledger + status history   (the movement is explained in the same commit)
 */
import { randomUUID } from 'node:crypto';

import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import { ROLES } from '../../config/env.js';
import { assertWarehouseInScope } from '../../lib/warehouseScope.js';
import * as repo from './orders.repository.js';

/**
 * Legal status transitions.
 *
 * `Cancelled` is deliberately not reachable from here. Cancellation restocks
 * inventory, and routing it through a second code path would eventually produce
 * an order marked cancelled whose stock was never returned. There is exactly one
 * cancellation entry point: cancelOrder().
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  Pending: ['Processing', 'Partially Shipped', 'Shipped'],
  Processing: ['Partially Shipped', 'Shipped'],
  'Partially Shipped': ['Shipped', 'Delivered'],
  Shipped: ['Delivered'],
  Delivered: [],
  Cancelled: [],
});

// ---------------------------------------------------------------------------
// Line normalisation
// ---------------------------------------------------------------------------

/**
 * Collapses duplicate (product, warehouse) pairs into one line.
 *
 * This is not cosmetic. `UPDATE ... FROM` with two source rows matching the same
 * target row updates it once with an unpredictable winner, so an unmerged
 * payload of [{A, w1, 3}, {A, w1, 4}] could silently consume only 3 or only 4.
 * Merging first makes the outcome exactly 7.
 *
 * `warehouse_id` is normalised to `null` for "let the service choose", which
 * keeps the merge key stable across the two passes (before and after allocation).
 */
export function mergeLines(items) {
  const merged = new Map();

  for (const item of items) {
    const warehouseId = item.warehouse_id ?? null;
    const key = `${item.product_id}:${warehouseId ?? 'auto'}`;
    const existing = merged.get(key);

    if (existing) {
      existing.qty += item.quantity;
    } else {
      merged.set(key, {
        product_id: item.product_id,
        warehouse_id: warehouseId,
        qty: item.quantity,
      });
    }
  }

  return [...merged.values()];
}

export function assertQuantitiesWithinLimits(lines, maxPerLine) {
  const tooLarge = lines
    .filter((line) => line.qty > maxPerLine)
    .map((line) => ({
      product_id: line.product_id,
      warehouse_id: line.warehouse_id,
      quantity: line.qty,
      limit: maxPerLine,
    }));

  if (tooLarge.length) {
    throw AppError.unprocessable(
      `Combined quantity for a line exceeds the limit of ${maxPerLine}`,
      'QUANTITY_LIMIT_EXCEEDED',
      tooLarge,
    );
  }
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * Decides which warehouse fulfils each line.
 *
 * An explicit `warehouse_id` is honoured (and validated). A line without one is
 * allocated to the warehouse holding the most stock for that product, preferring
 * a warehouse that can satisfy the line in full. When nothing can, the largest
 * holder is still chosen so the resulting 409 can quote a meaningful shortfall
 * instead of a bare "insufficient stock".
 *
 * Allocation is a *hint*: it does not reserve anything. Authoritative checking
 * happens in the conditional UPDATE, so a poor choice here can never cause
 * overselling -- only a retryable conflict.
 */
async function resolveWarehouses(db, lines, scope) {
  const explicitIds = [...new Set(lines.filter((l) => l.warehouse_id).map((l) => l.warehouse_id))];

  if (explicitIds.length) {
    if (scope !== undefined) {
      for (const warehouseId of explicitIds) assertWarehouseInScope(scope, warehouseId);
    }

    const { rows } = await repo.findActiveWarehouses(db, explicitIds);
    const found = new Set(rows.map((r) => Number(r.id)));
    const unknown = explicitIds.filter((id) => !found.has(id));
    if (unknown.length) {
      throw AppError.unprocessable(
        'Unknown, inactive or deleted warehouse',
        'WAREHOUSE_UNAVAILABLE',
        { warehouse_ids: unknown },
      );
    }
  }

  const needsAllocation = lines.filter((l) => !l.warehouse_id);
  if (needsAllocation.length === 0) return lines;

  const productIds = [...new Set(needsAllocation.map((l) => l.product_id))];
  const { rows: candidates } = await repo.findStockCandidates(db, productIds, scope);

  const byProduct = new Map();
  for (const candidate of candidates) {
    const list = byProduct.get(Number(candidate.product_id)) ?? [];
    list.push(candidate); // already ordered: quantity DESC, warehouse_id ASC
    byProduct.set(Number(candidate.product_id), list);
  }

  return lines.map((line) => {
    if (line.warehouse_id) return line;

    const options = byProduct.get(line.product_id) ?? [];
    const chosen = options.find((o) => o.quantity >= line.qty) ?? options[0];

    if (!chosen) {
      throw AppError.conflict(
        `Product ${line.product_id} is not stocked in any active warehouse`,
        'NO_STOCK_LOCATION',
        { product_id: line.product_id, requested: line.qty, available: 0 },
      );
    }

    return { ...line, warehouse_id: Number(chosen.warehouse_id) };
  });
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function mapOrder(row) {
  return {
    id: row.id,
    order_number: row.order_number,
    status: row.status,
    // NUMERIC arrives as a string and stays one: converting to a JS number here
    // would reintroduce the floating-point error the database just avoided.
    total_amount: row.total_amount,
    currency: row.currency,
    client: { id: row.client_id, name: row.client_name, email: row.client_email },
    cancelled_reason: row.cancelled_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapItem(row) {
  return {
    id: row.id,
    product_id: row.product_id,
    warehouse: { id: row.warehouse_id, code: row.warehouse_code, name: row.warehouse_name },
    product_sku: row.product_sku,
    product_name: row.product_name,
    quantity: row.quantity,
    price_at_purchase: row.price_at_purchase,
    line_total: row.line_total,
  };
}

async function loadOrder(db, orderId, { withHistory = false } = {}) {
  const [orderResult, itemsResult] = await Promise.all([
    repo.findOrderWithItems(db, orderId),
    repo.findOrderItems(db, orderId),
  ]);

  const row = orderResult.rows[0];
  if (!row) throw AppError.notFound('Order not found', 'ORDER_NOT_FOUND');

  const order = { ...mapOrder(row), items: itemsResult.rows.map(mapItem) };

  if (withHistory) {
    const history = await repo.findStatusHistory(db, orderId);
    order.status_history = history.rows.map((h) => ({
      from: h.from_status,
      to: h.to_status,
      changed_by: h.changed_by_name,
      at: h.created_at,
    }));
  }

  return order;
}

/**
 * Visibility check for a single order.
 *
 * Out-of-scope orders return 404 rather than 403 on purpose: a 403 confirms that
 * the id exists, which lets someone enumerate other customers' orders. A 404
 * reveals nothing.
 */
function assertOrderVisible({ order, actor, scope }) {
  if (actor.role === ROLES.ADMIN) return;
  if (actor.role === ROLES.CLIENT) {
    if (Number(order.client.id) === Number(actor.id)) return;
    throw AppError.notFound('Order not found', 'ORDER_NOT_FOUND');
  }

  const visible = order.items.some((item) => scope?.all || scope?.ids?.includes(item.warehouse.id));
  if (!visible) throw AppError.notFound('Order not found', 'ORDER_NOT_FOUND');
}

function restrictOrderToScope(order, scope) {
  const items = order.items.filter((item) => scope?.ids?.includes(Number(item.warehouse.id)));
  if (items.length === 0) throw AppError.notFound('Order not found', 'ORDER_NOT_FOUND');

  const totalCents = items.reduce(
    (total, item) => total + Math.round(Number(item.line_total) * 100),
    0,
  );
  return { ...order, items, total_amount: (totalCents / 100).toFixed(2) };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function isIdempotencyCollision(error) {
  return error?.code === '23505' && String(error?.constraint ?? '').includes('idempotency');
}

/**
 * Creates an order.
 *
 * @param {{ actor: {id:number, role:string}, items: Array, currency?: string, idempotencyKey?: string, limits: {maxLines:number, maxPerLine:number} }} params
 */
export async function createOrder({ actor, items, currency = 'USD', idempotencyKey, limits, scope }) {
  const warehouseScope =
    actor.role === ROLES.ADMIN || actor.role === ROLES.CLIENT ? undefined : scope;

  if (
    actor.role !== ROLES.ADMIN &&
    actor.role !== ROLES.CLIENT &&
    (!warehouseScope || (!warehouseScope.all && !warehouseScope.ids?.length))
  ) {
    throw AppError.forbidden('You do not have access to any warehouse', 'WAREHOUSE_FORBIDDEN');
  }

  const key = idempotencyKey ?? randomUUID();

  const run = () =>
    withTransaction(async (db) => {
      // 1. Idempotency: a retried request returns the original order untouched.
      const existing = await repo.findByIdempotencyKey(db, key);
      if (existing.rowCount > 0) {
        return { order: await loadOrder(db, existing.rows[0].id), replayed: true };
      }

      // 2. Normalise, then validate the catalogue.
      const requested = mergeLines(items);
      assertQuantitiesWithinLimits(requested, limits.maxPerLine);

      const productIds = [...new Set(requested.map((l) => l.product_id))].sort((a, b) => a - b);
      const { rows: products } = await repo.lockProductsForOrder(db, productIds);
      const known = new Map(products.map((p) => [Number(p.id), p]));

      const unknown = productIds.filter((id) => !known.has(id));
      if (unknown.length) {
        throw AppError.unprocessable('Unknown product', 'UNKNOWN_PRODUCT', { product_ids: unknown });
      }

      const unavailable = products
        .filter((p) => !p.is_active || p.deleted_at)
        .map((p) => ({ product_id: p.id, sku: p.sku }));
      if (unavailable.length) {
        throw AppError.unprocessable(
          'One or more products are not available for sale',
          'PRODUCT_UNAVAILABLE',
          unavailable,
        );
      }

      // 3. Resolve a warehouse per line, then merge again: an explicit line and
      //    an auto-allocated line can land on the same warehouse.
      const allocated = mergeLines(
        (await resolveWarehouses(db, requested, warehouseScope)).map((l) => ({
          product_id: l.product_id,
          warehouse_id: l.warehouse_id,
          quantity: l.qty,
        })),
      ).map((l) => ({ product_id: l.product_id, warehouse_id: l.warehouse_id, qty: l.qty }));

      assertQuantitiesWithinLimits(allocated, limits.maxPerLine);

      // 4. Take locks in a deterministic order so concurrent orders queue
      //    instead of deadlocking.
      await repo.lockInventoryRows(db, allocated);

      // 5. Header + lines. Total is computed in SQL from current prices.
      const order = await repo.createOrder(db, {
        clientId: actor.id,
        currency,
        idempotencyKey: key,
        lines: allocated,
      });
      await repo.insertOrderItems(db, order.id, allocated);

      // 6. The guard. If fewer rows come back than we asked for, at least one
      //    line could not be satisfied and the entire order must disappear.
      const decremented = await repo.decrementInventory(db, allocated);
      if (decremented.rowCount !== allocated.length) {
        const succeeded = new Set(
          decremented.rows.map((r) => `${r.product_id}:${r.warehouse_id}`),
        );
        const { rows: availability } = await repo.inspectAvailability(db, allocated);
        const availableByLine = new Map(
          availability.map((r) => [`${r.product_id}:${r.warehouse_id}`, r.available]),
        );

        const shortages = allocated
          .filter((line) => !succeeded.has(`${line.product_id}:${line.warehouse_id}`))
          .map((line) => ({
            product_id: line.product_id,
            warehouse_id: line.warehouse_id,
            requested: line.qty,
            available: availableByLine.get(`${line.product_id}:${line.warehouse_id}`) ?? 0,
          }));

        throw AppError.conflict(
          'Insufficient stock for one or more lines; no part of this order was placed',
          'INSUFFICIENT_STOCK',
          { lines: shortages },
        );
      }

      // 7. Explain the movement, in the same commit as the movement.
      await repo.insertLedgerEntries(db, {
        orderId: order.id,
        lines: allocated,
        actorId: actor.id,
      });
      await repo.insertStatusHistory(db, {
        orderId: order.id,
        from: null,
        to: 'Pending',
        changedBy: actor.id,
      });

      return { order: await loadOrder(db, order.id), replayed: false };
    });

  try {
    return await run();
  } catch (error) {
    // Two requests carrying the same key can both pass the step-1 lookup and
    // race to insert. The loser hits the unique index; resolve it into the
    // honest answer -- the order already exists -- instead of a confusing 409.
    if (isIdempotencyCollision(error)) {
      const existing = await repo.findByIdempotencyKey(pool, key);
      if (existing.rowCount > 0) {
        return { order: await loadOrder(pool, existing.rows[0].id), replayed: true };
      }
    }
    throw error;
  }
}

export async function getOrder({ actor, orderId, scope }) {
  const order = await loadOrder(pool, orderId, { withHistory: true });
  assertOrderVisible({ order, actor, scope });
  return actor.role === ROLES.ADMIN || actor.role === ROLES.CLIENT || scope?.all
    ? order
    : restrictOrderToScope(order, scope);
}

export async function listOrders({ actor, scope, filters }) {
  // A Client only ever sees their own orders; internal roles are limited by the
  // warehouse scope computed from their grants.
  const clientId = actor.role === ROLES.CLIENT ? actor.id : filters.client_id;

  return repo.listOrders(pool, {
    scope: actor.role === ROLES.CLIENT ? undefined : scope,
    clientId,
    status: filters.status,
    warehouseId: filters.warehouse_id,
    from: filters.from,
    to: filters.to,
    limit: filters.limit,
    offset: (filters.page - 1) * filters.limit,
  });
}

/**
 * Cancels an order and returns its stock.
 *
 * Restocking happens in the same transaction as the status change, and writes
 * its own ledger row, so "cancelled" and "stock came back" can never disagree.
 */
export async function cancelOrder({ actor, orderId, reason, scope }) {
  return withTransaction(async (db) => {
    const { rows } = await repo.lockOrderForUpdate(db, orderId);
    const order = rows[0];
    if (!order) throw AppError.notFound('Order not found', 'ORDER_NOT_FOUND');

    if (actor.role === ROLES.CLIENT && Number(order.client_id) !== Number(actor.id)) {
      throw AppError.notFound('Order not found', 'ORDER_NOT_FOUND');
    }

    const { rows: itemRows } = await repo.findOrderLinesForRestock(db, orderId);
    if (
      actor.role !== ROLES.ADMIN &&
      actor.role !== ROLES.CLIENT &&
      !itemRows.every((item) => scope?.all || scope?.ids?.includes(Number(item.warehouse_id)))
    ) {
      throw AppError.notFound('Order not found', 'ORDER_NOT_FOUND');
    }

    if (order.status === 'Cancelled') {
      throw AppError.conflict('This order is already cancelled', 'ORDER_ALREADY_CANCELLED');
    }
    if (order.status === 'Shipped' || order.status === 'Delivered') {
      throw AppError.conflict(
        'Shipped or delivered orders cannot be cancelled; raise a return instead',
        'ORDER_ALREADY_FULFILLED',
        { status: order.status },
      );
    }

    const lines = itemRows.map((r) => ({
      product_id: r.product_id,
      warehouse_id: r.warehouse_id,
      qty: r.quantity,
    }));

    if (lines.length) {
      // Deterministic order again: cancellation can run concurrently with new
      // orders touching the same rows.
      lines.sort((a, b) => a.product_id - b.product_id || a.warehouse_id - b.warehouse_id);
      await repo.lockInventoryRows(db, lines);

      const touched = await repo.restockInventory(db, lines);
      if (touched !== lines.length) {
        // Missing inventory rows would mean the ledger and stock have diverged.
        // Fail loudly rather than leave the system quietly inconsistent.
        throw new AppError(
          500,
          'INVENTORY_INCONSISTENT',
          'Could not return all stock: an inventory record is missing',
          { expected: lines.length, returned: touched },
        );
      }

      await repo.insertLedgerEntries(db, {
        orderId,
        lines,
        actorId: actor.id,
        reason: 'restock',
        direction: 'in',
      });
    }

    await repo.updateOrderStatus(db, { orderId, status: 'Cancelled', cancelledReason: reason });
    await repo.insertStatusHistory(db, {
      orderId,
      from: order.status,
      to: 'Cancelled',
      changedBy: actor.id,
    });

    return loadOrder(db, orderId, { withHistory: true });
  });
}

/** Advances an order through its lifecycle. Cancellation has its own path. */
export async function updateOrderStatus({ actor, orderId, status, scope }) {
  if (status === 'Cancelled') {
    throw AppError.badRequest(
      'Use POST /api/orders/:id/cancel so that stock is returned as well',
      'USE_CANCEL_ENDPOINT',
    );
  }

  return withTransaction(async (db) => {
    const { rows } = await repo.lockOrderForUpdate(db, orderId);
    const order = rows[0];
    if (!order) throw AppError.notFound('Order not found', 'ORDER_NOT_FOUND');

    if (!scope?.all) {
      const { rows: scoped } = await repo.findOrderItems(db, orderId);
      const visible =
        scoped.length > 0 && scoped.every((item) => scope?.ids?.includes(Number(item.warehouse_id)));
      if (!visible) throw AppError.notFound('Order not found', 'ORDER_NOT_FOUND');
    }

    const allowed = ALLOWED_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(status)) {
      throw AppError.conflict(
        `Cannot move an order from ${order.status} to ${status}`,
        'INVALID_STATUS_TRANSITION',
        { from: order.status, to: status, allowed },
      );
    }

    await repo.updateOrderStatus(db, { orderId, status });
    await repo.insertStatusHistory(db, {
      orderId,
      from: order.status,
      to: status,
      changedBy: actor.id,
    });

    return loadOrder(db, orderId, { withHistory: true });
  });
}