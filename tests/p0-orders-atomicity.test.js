/**
 * P0 :: Order atomicity.
 *
 * These are the tests that justify the project's central claim. Each one fails
 * against a naive "SELECT quantity, then UPDATE quantity" implementation, and
 * each one is written to be read: the assertion states the business rule, not
 * just the returned number.
 *
 * A real PostgreSQL server is used. Row-lock re-evaluation under READ COMMITTED
 * is a PostgreSQL behaviour; nothing else can stand in for it.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { concurrently, query, resetDatabase, scalar, startServer } from './helpers/harness.js';
import { createProduct, createWorld, receiveStock } from './helpers/fixtures.js';

describe('P0 :: order atomicity and concurrency', () => {
  let world;
  let server;

  before(async () => {
    await resetDatabase();
    server = await startServer();
    world = await createWorld(server.baseUrl);
  });

  after(async () => {
    await server.close();
  });

  /** Creates a product with an exact amount of stock in one warehouse. */
  async function stockedProduct({ warehouseId, quantity, unitPrice = '10.00' }) {
    const product = await createProduct(world.admin.api, {
      unit_price: unitPrice,
      reorder_level: 0,
    });
    if (quantity > 0) {
      await receiveStock(world.admin.api, { warehouseId, productId: product.id, quantity });
    }
    return product;
  }

  async function stockOf(warehouseId, productId) {
    return scalar(
      'SELECT quantity FROM inventory WHERE warehouse_id = $1 AND product_id = $2',
      [warehouseId, productId],
    );
  }

  it('never oversells the last unit: 10 concurrent orders, exactly 1 winner', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await stockedProduct({ warehouseId, quantity: 1 });

    const responses = await concurrently(10, () =>
      world.clients.acme.api.post('/api/orders', {
        items: [{ product_id: product.id, quantity: 1, warehouse_id: warehouseId }],
      }),
    );

    const created = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 409);

    assert.equal(created.length, 1, 'exactly one order may consume the last unit');
    assert.equal(rejected.length, 9, 'every other attempt must be refused');
    assert.ok(
      rejected.every((r) => r.body.error.code === 'INSUFFICIENT_STOCK'),
      'refusals must be a specific, actionable conflict',
    );

    // The database is the source of truth, not the HTTP responses.
    assert.equal(await stockOf(warehouseId, product.id), 0, 'stock must land exactly on zero');

    assert.equal(
      await scalar('SELECT count(*)::int FROM orders WHERE client_id = $1', [world.clients.acme.id]),
      1,
      'a losing transaction must leave no order header behind',
    );
    assert.equal(
      await scalar(
        `SELECT count(*)::int FROM inventory_transactions WHERE ref_type = 'order' AND product_id = $1`,
        [product.id],
      ),
      1,
      'the ledger must contain exactly one sale for the one successful order',
    );
  });

  it('sells exactly as many units as exist: 20 concurrent orders against 5 units', async () => {
    const warehouseId = world.warehouses.lagos.id;
    const product = await stockedProduct({ warehouseId, quantity: 5 });

    const responses = await concurrently(20, () =>
      world.clients.globex.api.post('/api/orders', {
        items: [{ product_id: product.id, quantity: 1, warehouse_id: warehouseId }],
      }),
    );

    const created = responses.filter((r) => r.status === 201);
    assert.equal(created.length, 5, 'five units means five successful orders, no more and no less');
    assert.equal(await stockOf(warehouseId, product.id), 0);
  });

  it('rolls the whole order back when one line cannot be satisfied', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const plentiful = await stockedProduct({ warehouseId, quantity: 10 });
    const scarce = await stockedProduct({ warehouseId, quantity: 1 });

    const ordersBefore = await scalar('SELECT count(*)::int FROM orders');
    const ledgerBefore = await scalar('SELECT count(*)::int FROM inventory_transactions');

    const response = await world.clients.acme.api.post('/api/orders', {
      items: [
        { product_id: plentiful.id, quantity: 5, warehouse_id: warehouseId },
        { product_id: scarce.id, quantity: 5, warehouse_id: warehouseId },
      ],
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'INSUFFICIENT_STOCK');

    // The shortage report must name the failing line with real numbers.
    const shortage = response.body.error.details.lines[0];
    assert.equal(shortage.product_id, scarce.id);
    assert.equal(shortage.requested, 5);
    assert.equal(shortage.available, 1);

    // This is the assertion that matters: the *first* line was decremented and
    // then rolled back. Without a transaction it would stay consumed.
    assert.equal(
      await stockOf(warehouseId, plentiful.id),
      10,
      'stock consumed by a line that succeeded must be restored on rollback',
    );
    assert.equal(await stockOf(warehouseId, scarce.id), 1, 'the scarce line must be untouched');

    assert.equal(await scalar('SELECT count(*)::int FROM orders'), ordersBefore, 'no order header');
    assert.equal(
      await scalar('SELECT count(*)::int FROM order_items WHERE product_id = ANY($1::int[])', [
        [plentiful.id, scarce.id],
      ]),
      0,
      'no order lines',
    );
    assert.equal(
      await scalar('SELECT count(*)::int FROM inventory_transactions'),
      ledgerBefore,
      'no ledger entries -- the movement never happened',
    );
  });

  it('treats a repeated Idempotency-Key as the same order, not a second one', async () => {
    const warehouseId = world.warehouses.dubai.id;
    const product = await stockedProduct({ warehouseId, quantity: 10 });
    const key = crypto.randomUUID();

    const first = await world.clients.acme.api.post(
      '/api/orders',
      { items: [{ product_id: product.id, quantity: 3, warehouse_id: warehouseId }] },
      { headers: { 'idempotency-key': key } },
    );
    const second = await world.clients.acme.api.post(
      '/api/orders',
      { items: [{ product_id: product.id, quantity: 3, warehouse_id: warehouseId }] },
      { headers: { 'idempotency-key': key } },
    );

    assert.equal(first.status, 201, 'the first attempt creates the order');
    assert.equal(second.status, 200, 'the retry reports the existing order');
    assert.equal(second.body.meta.idempotent_replay, true);
    assert.equal(second.body.data.id, first.body.data.id, 'the retry returns the same order id');

    assert.equal(
      await stockOf(warehouseId, product.id),
      7,
      'a retried request must not consume stock twice',
    );
  });

  it('survives racing retries that carry the same key', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await stockedProduct({ warehouseId, quantity: 10 });
    const key = crypto.randomUUID();

    const responses = await concurrently(5, () =>
      world.clients.globex.api.post(
        '/api/orders',
        { items: [{ product_id: product.id, quantity: 2, warehouse_id: warehouseId }] },
        { headers: { 'idempotency-key': key } },
      ),
    );

    const ids = new Set(responses.filter((r) => r.status < 300).map((r) => r.body.data.id));
    assert.equal(ids.size, 1, 'concurrent retries must converge on a single order');
    assert.equal(
      await stockOf(warehouseId, product.id),
      8,
      'exactly one decrement of 2 units may occur',
    );
  });

  it('merges duplicate lines instead of double-counting or under-counting them', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await stockedProduct({ warehouseId, quantity: 10, unitPrice: '10.00' });

    const response = await world.clients.acme.api.post('/api/orders', {
      items: [
        { product_id: product.id, quantity: 2, warehouse_id: warehouseId },
        { product_id: product.id, quantity: 3, warehouse_id: warehouseId },
      ],
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.items.length, 1, 'duplicate lines collapse into one');
    assert.equal(response.body.data.items[0].quantity, 5);
    assert.equal(await stockOf(warehouseId, product.id), 5, 'exactly 5 units consumed');
  });

  it('computes the total server-side and ignores a client-supplied amount', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    // A price that breaks binary floating point: 3 x 0.10 must be 0.30 exactly.
    const product = await stockedProduct({ warehouseId, quantity: 10, unitPrice: '0.10' });

    const response = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 3, warehouse_id: warehouseId }],
      total_amount: '0.01',
      currency: 'USD',
    });

    assert.equal(response.status, 201);
    assert.equal(
      response.body.data.total_amount,
      '0.30',
      'money must be exact decimal text, never a floating-point number',
    );
    assert.equal(typeof response.body.data.total_amount, 'string', 'NUMERIC is returned as text');
  });
});