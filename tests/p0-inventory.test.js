/**
 * P0 :: Inventory boundaries.
 *
 * Stock adjustments are the only place, outside orders, where quantity changes.
 * Every movement must be legal, explained, and attributed.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { query, resetDatabase, scalar, startServer } from './helpers/harness.js';
import { createProduct, createWorld, receiveStock } from './helpers/fixtures.js';

describe('P0 :: inventory boundaries', () => {
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

  const stockOf = (warehouseId, productId) =>
    scalar('SELECT quantity FROM inventory WHERE warehouse_id = $1 AND product_id = $2', [
      warehouseId,
      productId,
    ]);

  it('creates the stock row on first receipt and records a ledger entry', async () => {
    const warehouseId = world.warehouses.dubai.id;
    const product = await createProduct(world.admin.api, { reorder_level: 0, unit_price: '4.50' });

    const before = await query(
      'SELECT 1 FROM inventory WHERE warehouse_id = $1 AND product_id = $2',
      [warehouseId, product.id],
    );
    assert.equal(before.rowCount, 0, 'no stock row exists yet');

    const response = await receiveStock(world.admin.api, {
      warehouseId,
      productId: product.id,
      quantity: 25,
    });

    assert.equal(response.quantity, 25);
    assert.equal(await stockOf(warehouseId, product.id), 25);

    const ledger = await query(
      `SELECT delta, reason FROM inventory_transactions
        WHERE warehouse_id = $1 AND product_id = $2 ORDER BY id`,
      [warehouseId, product.id],
    );
    assert.equal(ledger.rowCount, 1);
    assert.equal(ledger.rows[0].reason, 'receipt');
    assert.equal(ledger.rows[0].delta, 25);
  });

  it('refuses an adjustment that would make stock negative', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await createProduct(world.admin.api, { reorder_level: 0, unit_price: '7.00' });
    await receiveStock(world.admin.api, { warehouseId, productId: product.id, quantity: 4 });

    const response = await world.admin.api.post('/api/inventory/adjust', {
      warehouse_id: warehouseId,
      product_id: product.id,
      delta: -5,
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'NEGATIVE_STOCK');
    assert.equal(response.body.error.details.available, 4);
    assert.equal(response.body.error.details.delta, -5);
    assert.equal(await stockOf(warehouseId, product.id), 4, 'the refused change must not partially apply');
  });

  it('refuses to reduce stock that does not exist at all', async () => {
    const product = await createProduct(world.admin.api, { reorder_level: 0, unit_price: '1.00' });

    const response = await world.admin.api.post('/api/inventory/adjust', {
      warehouse_id: world.warehouses.dubai.id,
      product_id: product.id,
      delta: -1,
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'STOCK_RECORD_NOT_FOUND');
  });

  it('accepts an exact reduction to zero', async () => {
    const warehouseId = world.warehouses.lagos.id;
    const product = await createProduct(world.admin.api, { reorder_level: 0, unit_price: '2.00' });
    await receiveStock(world.admin.api, { warehouseId, productId: product.id, quantity: 6 });

    const response = await world.admin.api.post('/api/inventory/adjust', {
      warehouse_id: warehouseId,
      product_id: product.id,
      delta: -6,
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.quantity, 0);
  });

  it('rejects a zero or non-integer adjustment', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await createProduct(world.admin.api, { reorder_level: 0, unit_price: '2.00' });

    for (const delta of [0, 1.5, 'abc']) {
      const response = await world.admin.api.post('/api/inventory/adjust', {
        warehouse_id: warehouseId,
        product_id: product.id,
        delta,
      });
      assert.equal(response.status, 422, `delta ${delta} must be rejected`);
    }
  });

  it('labels a downward correction differently from a receipt', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await createProduct(world.admin.api, { reorder_level: 0, unit_price: '2.00' });
    await receiveStock(world.admin.api, { warehouseId, productId: product.id, quantity: 10 });

    await world.admin.api.post('/api/inventory/adjust', {
      warehouse_id: warehouseId,
      product_id: product.id,
      delta: -3,
      note: 'Damaged in transit',
    });

    const reasons = await query(
      `SELECT reason, delta FROM inventory_transactions
        WHERE warehouse_id = $1 AND product_id = $2 ORDER BY id`,
      [warehouseId, product.id],
    );

    assert.deepEqual(
      reasons.rows.map((row) => [row.reason, row.delta]),
      [
        ['receipt', 10],
        ['adjustment', -3],
      ],
    );
    assert.equal(await stockOf(warehouseId, product.id), 7);
  });

  it('reports low stock per warehouse and filters by it', async () => {
    const warehouseId = world.warehouses.dubai.id;
    const lowProduct = await createProduct(world.admin.api, { reorder_level: 10, unit_price: '9.00' });
    const healthyProduct = await createProduct(world.admin.api, { reorder_level: 10, unit_price: '9.00' });

    await receiveStock(world.admin.api, { warehouseId, productId: lowProduct.id, quantity: 3 });
    await receiveStock(world.admin.api, { warehouseId, productId: healthyProduct.id, quantity: 80 });

    const lowStock = await world.admin.api.get('/api/inventory/low-stock', { query: { limit: 200 } });
    const lowIds = lowStock.body.data.map((row) => row.product.id);

    assert.ok(lowIds.includes(lowProduct.id), 'quantity below the threshold must be reported');
    assert.ok(!lowIds.includes(healthyProduct.id), 'healthy stock must not be reported');

    const entry = lowStock.body.data.find((row) => row.product.id === lowProduct.id);
    assert.equal(entry.quantity, 3);
    assert.equal(entry.reorder_level, 10);
    assert.equal(entry.units_below_threshold, 7);

    const filtered = await world.admin.api.get('/api/inventory', {
      query: { low_stock: 'true', limit: 100 },
    });
    assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
    assert.ok(filtered.body.data.every((row) => row.is_low_stock === true));

    const healthy = await world.admin.api.get('/api/inventory', {
      query: { low_stock: 'false', limit: 100 },
    });
    assert.equal(healthy.status, 200, JSON.stringify(healthy.body));
    assert.ok(healthy.body.data.every((row) => row.is_low_stock === false));
  });

  it('exposes the movement history for a product', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await createProduct(world.admin.api, { reorder_level: 0, unit_price: '6.00' });
    await receiveStock(world.admin.api, { warehouseId, productId: product.id, quantity: 9 });

    const order = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 2, warehouse_id: warehouseId }],
    });
    assert.equal(order.status, 201);

    const ledger = await world.admin.api.get('/api/inventory/ledger', {
      query: { product_id: product.id, limit: 50 },
    });

    assert.equal(ledger.status, 200);
    assert.deepEqual(
      ledger.body.data.map((row) => [row.reason, row.delta]),
      [
        ['sale', -2],
        ['receipt', 9],
      ],
      'newest first, with the order as the origin of the sale',
    );
    assert.equal(ledger.body.data[0].ref_type, 'order');
  });

  it('computes stock value as exact decimal money', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await createProduct(world.admin.api, { reorder_level: 0, unit_price: '19.99' });
    await receiveStock(world.admin.api, { warehouseId, productId: product.id, quantity: 3 });

    const response = await world.admin.api.get('/api/inventory', {
      query: { product_id: product.id, warehouse_id: warehouseId },
    });

    assert.equal(response.status, 200);
    assert.equal(
      response.body.data[0].stock_value,
      '59.97',
      '3 x 19.99 must be 59.97, not a floating-point approximation',
    );
  });
});