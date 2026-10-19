/**
 * P0 :: Order lifecycle and boundary behaviour.
 *
 * Single-dimension edge cases: the boundary values that a happy-path test never
 * touches, and the state machine that stops an order drifting into an impossible
 * status.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { query, resetDatabase, scalar, startServer } from './helpers/harness.js';
import { createProduct, createWarehouse, createWorld, receiveStock } from './helpers/fixtures.js';

describe('P0 :: order lifecycle and boundaries', () => {
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

  async function stockedProduct({ warehouseId, quantity, unitPrice = '25.00' }) {
    const product = await createProduct(world.admin.api, { unit_price: unitPrice, reorder_level: 0 });
    if (quantity > 0) {
      await receiveStock(world.admin.api, { warehouseId, productId: product.id, quantity });
    }
    return product;
  }

  const stockOf = (warehouseId, productId) =>
    scalar('SELECT quantity FROM inventory WHERE warehouse_id = $1 AND product_id = $2', [
      warehouseId,
      productId,
    ]);

  it('accepts an order for exactly the remaining stock, then refuses one more', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await stockedProduct({ warehouseId, quantity: 5 });

    const exact = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 5, warehouse_id: warehouseId }],
    });
    assert.equal(exact.status, 201, 'the boundary value itself must succeed (>= not >)');
    assert.equal(await stockOf(warehouseId, product.id), 0);

    const over = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 1, warehouse_id: warehouseId }],
    });
    assert.equal(over.status, 409);
    assert.equal(over.body.error.details.lines[0].available, 0, 'the refusal quotes real stock');
  });

  it('allocates an unassigned line to the warehouse holding the most stock', async () => {
    const warehouseA = await createWarehouse(world.admin.api, { name: 'Allocation A' });
    const warehouseB = await createWarehouse(world.admin.api, { name: 'Allocation B' });

    const product = await createProduct(world.admin.api, { unit_price: '10.00', reorder_level: 0 });
    await receiveStock(world.admin.api, { warehouseId: warehouseA.id, productId: product.id, quantity: 5 });
    await receiveStock(world.admin.api, { warehouseId: warehouseB.id, productId: product.id, quantity: 40 });

    const response = await world.clients.globex.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 10 }], // no warehouse_id
    });

    assert.equal(response.status, 201);
    assert.equal(
      response.body.data.items[0].warehouse.id,
      warehouseB.id,
      'the deepest stock position should fulfil the line',
    );
    assert.equal(await stockOf(warehouseB.id, product.id), 30);
    assert.equal(await stockOf(warehouseA.id, product.id), 5, 'the smaller warehouse is untouched');
  });

  it('reports when a product is stocked nowhere', async () => {
    const product = await createProduct(world.admin.api, { unit_price: '5.00', reorder_level: 0 });

    const response = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 1 }],
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'NO_STOCK_LOCATION');
  });

  it('rejects malformed quantities before touching the database', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await stockedProduct({ warehouseId, quantity: 10 });

    const cases = [
      { quantity: 0, label: 'zero' },
      { quantity: -5, label: 'negative' },
      { quantity: 1.5, label: 'fractional' },
      { quantity: 999_999_999, label: 'above the per-line ceiling' },
      { quantity: 'five', label: 'not a number' },
    ];

    for (const testCase of cases) {
      const response = await world.clients.acme.api.post('/api/orders', {
        items: [{ product_id: product.id, quantity: testCase.quantity, warehouse_id: warehouseId }],
      });
      assert.equal(response.status, 422, `${testCase.label} must be rejected with 422`);
      assert.equal(response.body.error.code, 'VALIDATION_FAILED');
    }

    assert.equal(await stockOf(warehouseId, product.id), 10, 'no stock was consumed by bad input');
  });

  it('rejects an empty order, an unknown product and an unknown warehouse', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await stockedProduct({ warehouseId, quantity: 5 });

    const empty = await world.clients.acme.api.post('/api/orders', { items: [] });
    assert.equal(empty.status, 422);

    const unknownProduct = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: 999_999, quantity: 1 }],
    });
    assert.equal(unknownProduct.status, 422);
    assert.equal(unknownProduct.body.error.code, 'UNKNOWN_PRODUCT');

    const unknownWarehouse = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 1, warehouse_id: 999_999 }],
    });
    assert.equal(unknownWarehouse.status, 422);
    assert.equal(unknownWarehouse.body.error.code, 'WAREHOUSE_UNAVAILABLE');
  });

  it('refuses to sell a product that has been archived', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await stockedProduct({ warehouseId, quantity: 5 });

    const archived = await world.admin.api.delete(`/api/products/${product.id}`);
    assert.equal(archived.status, 200);

    const response = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 1, warehouse_id: warehouseId }],
    });

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'PRODUCT_UNAVAILABLE');
  });

  it('returns stock to the warehouse when an order is cancelled, and records it', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await stockedProduct({ warehouseId, quantity: 10 });

    const created = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 4, warehouse_id: warehouseId }],
    });
    assert.equal(created.status, 201);
    const orderId = created.body.data.id;
    assert.equal(await stockOf(warehouseId, product.id), 6);

    const cancelled = await world.clients.acme.api.post(`/api/orders/${orderId}/cancel`, {
      reason: 'Ordered in error by the customer',
    });

    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'Cancelled');
    assert.equal(await stockOf(warehouseId, product.id), 10, 'cancellation must restore everything');

    const ledger = await query(
      `SELECT delta, reason FROM inventory_transactions
        WHERE ref_type = 'order' AND ref_id = $1 ORDER BY id`,
      [orderId],
    );
    assert.deepEqual(
      ledger.rows.map((row) => [row.reason, row.delta]),
      [
        ['sale', -4],
        ['restock', 4],
      ],
      'both the sale and the return must be in the ledger',
    );

    const again = await world.clients.acme.api.post(`/api/orders/${orderId}/cancel`, {
      reason: 'Trying twice',
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ORDER_ALREADY_CANCELLED');
    assert.equal(await stockOf(warehouseId, product.id), 10, 'a second cancel must not re-add stock');
  });

  it('refuses to cancel a shipped order', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await stockedProduct({ warehouseId, quantity: 10 });

    const created = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 2, warehouse_id: warehouseId }],
    });
    const orderId = created.body.data.id;

    const shipped = await world.managers.nairobi.api.patch(`/api/orders/${orderId}/status`, {
      status: 'Shipped',
    });
    assert.equal(shipped.status, 200);

    const cancel = await world.clients.acme.api.post(`/api/orders/${orderId}/cancel`, {
      reason: 'Changed my mind',
    });
    assert.equal(cancel.status, 409);
    assert.equal(cancel.body.error.code, 'ORDER_ALREADY_FULFILLED');
    assert.equal(await stockOf(warehouseId, product.id), 8, 'shipped stock must not be returned');
  });

  it('enforces legal status transitions and blocks the cancel shortcut', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await stockedProduct({ warehouseId, quantity: 10 });

    const created = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 1, warehouse_id: warehouseId }],
    });
    const orderId = created.body.data.id;

    const backwards = await world.managers.nairobi.api.patch(`/api/orders/${orderId}/status`, {
      status: 'Processing',
    });
    assert.equal(backwards.status, 200);

    const illegal = await world.managers.nairobi.api.patch(`/api/orders/${orderId}/status`, {
      status: 'Delivered',
    });
    assert.equal(illegal.status, 409, 'Processing cannot jump straight to Delivered');
    assert.equal(illegal.body.error.code, 'INVALID_STATUS_TRANSITION');
    assert.deepEqual(illegal.body.error.details.allowed, ['Partially Shipped', 'Shipped']);

    // Cancelling through the status endpoint would skip the restock.
    const shortcut = await world.managers.nairobi.api.patch(`/api/orders/${orderId}/status`, {
      status: 'Cancelled',
    });
    assert.equal(shortcut.status, 400);
    assert.equal(shortcut.body.error.code, 'USE_CANCEL_ENDPOINT');
  });

  it('shows a Client only their own orders, and hides a foreign order entirely', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await stockedProduct({ warehouseId, quantity: 20 });

    const acmeOrder = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 1, warehouse_id: warehouseId }],
    });

    const globexList = await world.clients.globex.api.get('/api/orders');
    assert.equal(globexList.status, 200);
    assert.ok(
      globexList.body.data.every((order) => order.id !== acmeOrder.body.data.id),
      "another client's order must not appear in the list",
    );

    // 404 rather than 403: a 403 would confirm that the id exists.
    const foreign = await world.clients.globex.api.get(`/api/orders/${acmeOrder.body.data.id}`);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error.code, 'ORDER_NOT_FOUND');
  });

  it('records every status change in the order history', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await stockedProduct({ warehouseId, quantity: 10 });

    const created = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 1, warehouse_id: warehouseId }],
    });
    const orderId = created.body.data.id;

    await world.managers.nairobi.api.patch(`/api/orders/${orderId}/status`, { status: 'Shipped' });
    await world.managers.nairobi.api.patch(`/api/orders/${orderId}/status`, { status: 'Delivered' });

    const detail = await world.managers.nairobi.api.get(`/api/orders/${orderId}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(
      detail.body.data.status_history.map((entry) => entry.to),
      ['Pending', 'Shipped', 'Delivered'],
      'the history must be complete and ordered',
    );
  });
});