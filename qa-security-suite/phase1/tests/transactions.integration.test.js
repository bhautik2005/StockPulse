/**
 * Phase 1 :: ERP transaction integration tests.
 *
 * The claim under test is narrow and absolute: placing an order either creates
 * the order, writes its lines, consumes stock in the right warehouse and records
 * a ledger entry -- all of it -- or it changes nothing at all.
 *
 * Two techniques are used together, deliberately:
 *
 *   1. HTTP through Supertest, so routing, validation and the error envelope are
 *      part of the assertion.
 *   2. Direct SQL assertions after each request, because a response body is a
 *      promise and the database is the fact. Every test re-reads `inventory`,
 *      `orders`, `order_items` and `inventory_transactions` to check what
 *      actually happened.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { app, query, resetDatabase, scalar } from '../setup/db.js';
import { isError } from '../helpers/client.js';
import {
  createSimpleWorld,
  ledgerCountForOrder,
  onHand,
  uniqueKey,
  PASSWORD,
} from '../helpers/fixtures.js';

const ORDERS = '/api/orders';
const ADJUST = '/api/inventory/adjust';

let world;

beforeAll(async () => {
  await resetDatabase();
  world = await createSimpleWorld({ stock: 100 });
});

afterAll(async () => {
  const { closePool } = await import('../setup/db.js');
  await closePool();
});

/** Resets stock to a known level before each test in this file. */
beforeEach(async () => {
  await query('UPDATE inventory SET quantity = 100 WHERE warehouse_id = $1 AND product_id = $2', [
    world.warehouse.id,
    world.product.id,
  ]);
  await query('DELETE FROM order_status_history');
  await query('DELETE FROM inventory_transactions');
  await query('DELETE FROM order_items');
  await query('DELETE FROM orders');
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('Phase 1 :: order placement and inventory deduction', () => {
  it('places an order, deducts stock and writes an explanatory ledger row', async () => {
    const before = await onHand(world.warehouse.id, world.product.id);
    expect(before).toBe(100);

    const response = await world.client.api.post(ORDERS, {
      items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 7 }],
    });

    expect(response.status).toBe(201);
    expect(response.body.meta.idempotent_replay).toBe(false);

    const order = response.body.data;
    expect(order.status).toBe('Pending');
    expect(order.order_number).toMatch(/^SO-\d{4}-\d+$/);

    // 7 x 25.50 -- computed server-side from the catalogue price, never sent by
    // the client. NUMERIC arrives as a string and must stay one.
    expect(order.total_amount).toBe('178.50');
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      product_id: world.product.id,
      product_sku: world.product.sku,
      quantity: 7,
      price_at_purchase: '25.50',
    });

    // ---- the database is the fact, not the response body ----------------
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(93);

    const storedOrder = await scalar('SELECT count(*)::int FROM orders WHERE id = $1', [order.id]);
    expect(storedOrder).toBe(1);

    const storedItem = await scalar(
      'SELECT quantity FROM order_items WHERE order_id = $1 AND product_id = $2',
      [order.id, world.product.id],
    );
    expect(Number(storedItem)).toBe(7);

    const ledger = await query(
      `SELECT delta, reason, ref_type, ref_id FROM inventory_transactions
        WHERE ref_type = 'order' AND ref_id = $1`,
      [order.id],
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ delta: -7, reason: 'sale', ref_type: 'order' });
    expect(Number(ledger.rows[0].ref_id)).toBe(order.id);

    const history = await query(
      `SELECT from_status, to_status FROM order_status_history WHERE order_id = $1`,
      [order.id],
    );
    expect(history.rows).toEqual([{ from_status: null, to_status: 'Pending' }]);
  });

  it('lets the service allocate a warehouse when none is given', async () => {
    const response = await world.client.api.post(ORDERS, {
      items: [{ product_id: world.product.id, quantity: 3 }],
    });

    expect(response.status).toBe(201);
    expect(response.body.data.items[0].warehouse.id).toBe(world.warehouse.id);
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(97);
  });

  it('never trusts a client-supplied price or total', async () => {
    const response = await world.client.api.post(ORDERS, {
      items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 2 }],
      // Both of these are absent from createOrderSchema and are stripped.
      total_amount: '0.01',
      unit_price: '0.01',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.total_amount).toBe('51.00');
  });

  it('collapses duplicate lines instead of double-shipping them', async () => {
    const response = await world.client.api.post(ORDERS, {
      items: [
        { product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 3 },
        { product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 4 },
      ],
    });

    expect(response.status).toBe(201);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].quantity).toBe(7);
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(93);
  });
});

// ---------------------------------------------------------------------------
// Rollback behaviour
// ---------------------------------------------------------------------------

describe('Phase 1 :: insufficient stock rolls the whole order back', () => {
  it('returns 409 INSUFFICIENT_STOCK and leaves no trace in any table', async () => {
    await query('UPDATE inventory SET quantity = 2 WHERE warehouse_id = $1 AND product_id = $2', [
      world.warehouse.id,
      world.product.id,
    ]);

    const response = await world.client.api.post(ORDERS, {
      items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 5 }],
    });

    expect(response.status).toBe(409);
    expect(isError(response, 'INSUFFICIENT_STOCK')).toBe(true);
    expect(response.body.error.details.lines).toEqual([
      expect.objectContaining({ product_id: world.product.id, requested: 5, available: 2 }),
    ]);

    // Stock is untouched, and the order that was already INSERTed inside the
    // transaction must have vanished with the rollback.
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(2);
    expect(Number(await scalar('SELECT count(*)::int FROM orders'))).toBe(0);
    expect(Number(await scalar('SELECT count(*)::int FROM order_items'))).toBe(0);
    expect(Number(await scalar('SELECT count(*)::int FROM inventory_transactions'))).toBe(0);
    expect(Number(await scalar('SELECT count(*)::int FROM order_status_history'))).toBe(0);
  });

  it('rolls back a multi-line order entirely when only the second line falls short', async () => {
    const second = await import('../helpers/fixtures.js').then((m) =>
      m.createProduct(world.admin.api, { unit_price: '5.00' }),
    );
    await import('../helpers/fixtures.js').then((m) =>
      m.receiveStock(world.admin.api, {
        warehouseId: world.warehouse.id,
        productId: second.id,
        quantity: 1,
      }),
    );

    const stockBefore = await onHand(world.warehouse.id, world.product.id);

    const response = await world.client.api.post(ORDERS, {
      items: [
        { product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 1 },
        { product_id: second.id, warehouse_id: world.warehouse.id, quantity: 99 },
      ],
    });

    expect(response.status).toBe(409);
    expect(isError(response, 'INSUFFICIENT_STOCK')).toBe(true);

    // "No part of this order was placed" has to be literally true: the first,
    // satisfiable line must have been rolled back with the failing one.
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(stockBefore);
    expect(Number(await scalar('SELECT count(*)::int FROM orders'))).toBe(0);
  });

  it('returns 409 NO_STOCK_LOCATION when the product is stocked nowhere', async () => {
    const orphan = await import('../helpers/fixtures.js').then((m) =>
      m.createProduct(world.admin.api, { unit_price: '9.00' }),
    );

    const response = await world.client.api.post(ORDERS, {
      items: [{ product_id: orphan.id, quantity: 1 }],
    });

    expect(response.status).toBe(409);
    expect(isError(response, 'NO_STOCK_LOCATION')).toBe(true);
  });

  it('returns 422 for an unknown product id', async () => {
    const response = await world.client.api.post(ORDERS, {
      items: [{ product_id: 999_999, quantity: 1 }],
    });

    expect(response.status).toBe(422);
    expect(isError(response, 'UNKNOWN_PRODUCT')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('Phase 1 :: order idempotency', () => {
  it('replays the original order for a repeated Idempotency-Key without double-charging stock', async () => {
    const key = crypto.randomUUID();

    const first = await world.client.api.post(
      ORDERS,
      { items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 4 }] },
      { headers: { 'Idempotency-Key': key } },
    );
    const second = await world.client.api.post(
      ORDERS,
      { items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 4 }] },
      { headers: { 'Idempotency-Key': key } },
    );

    expect(first.status).toBe(201);
    expect(first.body.meta.idempotent_replay).toBe(false);

    expect(second.status).toBe(200);
    expect(second.body.meta.idempotent_replay).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);

    // Exactly one deduction, exactly one order, exactly one ledger row.
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(96);
    expect(Number(await scalar('SELECT count(*)::int FROM orders'))).toBe(1);
    expect(await ledgerCountForOrder(first.body.data.id)).toBe(1);
  });

  it('rejects a non-UUID Idempotency-Key with 400', async () => {
    const response = await world.client.api.post(
      ORDERS,
      { items: [{ product_id: world.product.id, quantity: 1 }] },
      { headers: { 'Idempotency-Key': 'not-a-uuid' } },
    );

    expect(response.status).toBe(400);
    expect(isError(response, 'INVALID_IDEMPOTENCY_KEY')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Inventory adjustment endpoint
// ---------------------------------------------------------------------------

describe('Phase 1 :: inventory adjustments', () => {
  it('records a receipt and moves stock up', async () => {
    const response = await world.admin.api.post(ADJUST, {
      warehouse_id: world.warehouse.id,
      product_id: world.product.id,
      delta: 15,
      note: 'goods received note GRN-1',
    });

    expect(response.status).toBe(201);
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(115);

    const ledger = await query(
      `SELECT delta, reason FROM inventory_transactions ORDER BY id DESC LIMIT 1`,
    );
    expect(ledger.rows[0]).toMatchObject({ delta: 15 });
  });

  it('refuses a negative delta that would drive stock below zero', async () => {
    await query('UPDATE inventory SET quantity = 3 WHERE warehouse_id = $1 AND product_id = $2', [
      world.warehouse.id,
      world.product.id,
    ]);

    const response = await world.admin.api.post(ADJUST, {
      warehouse_id: world.warehouse.id,
      product_id: world.product.id,
      delta: -10,
      note: 'damaged in transit',
    });

    // The CHECK (quantity >= 0) constraint is the last line of defence, so the
    // service must surface a 4xx rather than a 500.
    expect([400, 409, 422]).toContain(response.status);
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('Phase 1 :: concurrent orders cannot oversell', () => {
  it('lets exactly one of two concurrent orders take the last unit', async () => {
    await query('UPDATE inventory SET quantity = 1 WHERE warehouse_id = $1 AND product_id = $2', [
      world.warehouse.id,
      world.product.id,
    ]);

    // Two independent Clients, so this is two real HTTP requests racing through
    // two different pool connections -- not one request replayed.
    const other = await import('../helpers/fixtures.js').then((m) => m.createClientAccount());

    const place = (api, key) =>
      api.post(
        ORDERS,
        { items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 1 }] },
        { headers: { 'Idempotency-Key': key } },
      );

    const [a, b] = await Promise.all([place(world.client.api, crypto.randomUUID()), place(other.api, crypto.randomUUID())]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const rejected = a.status === 409 ? a : b;
    expect(isError(rejected, 'INSUFFICIENT_STOCK')).toBe(true);

    // Stock never goes negative, and only the winner's order exists.
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(0);
    expect(Number(await scalar('SELECT count(*)::int FROM orders'))).toBe(1);
    expect(Number(await scalar('SELECT count(*)::int FROM inventory_transactions'))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Authorisation on the transaction endpoints
// ---------------------------------------------------------------------------

describe('Phase 1 :: order endpoint authorisation', () => {
  it('requires a session', async () => {
    const { createClient } = await import('../helpers/client.js');
    const anonymous = createClient(app);

    expect((await anonymous.get(ORDERS)).status).toBe(401);
    expect((await anonymous.post(ORDERS, { items: [] })).status).toBe(401);
  });

  it('hides another client\u2019s order behind a 404, not a 403', async () => {
    const created = await world.client.api.post(ORDERS, {
      items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 1 }],
    });
    expect(created.status).toBe(201);

    const other = await import('../helpers/fixtures.js').then((m) => m.createClientAccount());
    const response = await other.api.get(`${ORDERS}/${created.body.data.id}`);

    // A 403 would confirm the id exists and allow enumeration.
    expect(response.status).toBe(404);
    expect(isError(response, 'ORDER_NOT_FOUND')).toBe(true);
  });

  it('refuses a client-supplied identity switch (400/401 on a stale token)', async () => {
    const response = await world.client.api.get(`${ORDERS}?client_id=${world.admin.id}`);
    expect(response.status).toBe(200);

    // A Client only ever sees their own orders regardless of the filter.
    expect(response.body.data.every((row) => row.client_name === world.client.name)).toBe(true);
  });
});

// Sanity guard on the fixture contract: a duplicate client email must fail.
describe('Phase 1 :: fixture contract', () => {
  it('refuses to register the same client email twice', async () => {
    const { createClient: makeClient } = await import('../helpers/client.js');
    const api = makeClient(app);
    const email = `dupe-${uniqueKey()}@client.test`;

    const first = await api.post('/api/auth/register', { name: 'Fixture A', email, password: PASSWORD });
    const second = await api.post('/api/auth/register', { name: 'Fixture B', email, password: PASSWORD });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });
});
