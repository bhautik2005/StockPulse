/**
 * P0 :: Schema integrity.
 *
 * These tests attack the database directly, bypassing the API entirely. That is
 * the point: application-layer validation can be forgotten, bypassed by a future
 * script, or defeated by a race. Constraints, indexes and foreign keys are the
 * guarantees that hold regardless of which code path is writing.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { query, resetDatabase, scalar, startServer } from './helpers/harness.js';
import { createProduct, createWorld, receiveStock } from './helpers/fixtures.js';

/**
 * Asserts that raw SQL is refused by the database, with a specific SQLSTATE.
 *
 * `sqlStates` accepts an array because PostgreSQL distinguishes
 * foreign_key_violation (23503) from restrict_violation (23001) depending on how
 * the reference is declared.
 */
async function expectSqlError(sql, params, sqlStates, constraintPattern) {
  const expected = (Array.isArray(sqlStates) ? sqlStates : [sqlStates]).map(String);

  await assert.rejects(
    () => query(sql, params),
    (error) => {
      // node-postgres reports SQLSTATE as a string, so compare as strings.
      assert.ok(
        expected.includes(String(error.code)),
        `expected SQLSTATE ${expected.join(' or ')}, got ${error.code}: ${error.message}`,
      );
      if (constraintPattern) {
        // NOT NULL violations name a column; other constraints name themselves.
        const target = `${error.constraint ?? ''} ${error.column ?? ''}`;
        assert.match(target, constraintPattern, `expected ${constraintPattern}, got "${target}"`);
      }
      return true;
    },
  );
}

describe('P0 :: schema integrity enforced by PostgreSQL', () => {
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

  it('refuses to let inventory go negative, even by direct UPDATE', async () => {
    await expectSqlError(
      `UPDATE inventory SET quantity = -1 WHERE warehouse_id = $1 AND product_id = $2`,
      [world.warehouses.nairobi.id, world.products.keyboard.id],
      23514,
      /quantity/,
    );

    await expectSqlError(
      `UPDATE inventory SET quantity = quantity - 10000 WHERE warehouse_id = $1 AND product_id = $2`,
      [world.warehouses.nairobi.id, world.products.keyboard.id],
      23514,
      /quantity/,
    );
  });

  it('refuses zero or negative order quantities', async () => {
    const order = await world.clients.acme.api.post('/api/orders', {
      items: [
        {
          product_id: world.products.cable.id,
          quantity: 1,
          warehouse_id: world.warehouses.dubai.id,
        },
      ],
    });
    const orderId = order.body.data.id;

    for (const quantity of [0, -3]) {
      await expectSqlError(
        `INSERT INTO order_items (order_id, warehouse_id, product_sku, product_name, quantity, price_at_purchase)
         VALUES ($1, $2, 'X', 'X', $3, 1.00)`,
        [orderId, world.warehouses.dubai.id, quantity],
        23514,
        /quantity/,
      );
    }
  });

  it('refuses negative money', async () => {
    await expectSqlError(
      `INSERT INTO products (sku, name, unit_price) VALUES ($1, 'Negative', -1.00)`,
      [`NEG-${Date.now()}`],
      23514,
      /unit_price/,
    );

    await expectSqlError(
      `UPDATE orders SET total_amount = -5 WHERE id = (SELECT min(id) FROM orders)`,
      [],
      23514,
      /total_amount/,
    );
  });

  it('refuses an unknown role', async () => {
    await expectSqlError(
      `INSERT INTO users (name, email, password_hash, role) VALUES ('X', $1, 'hash', 'SuperAdmin')`,
      [`role-${Date.now()}@test.dev`],
      23514,
      /role/,
    );
  });

  it('treats emails and SKUs case-insensitively', async () => {
    await expectSqlError(
      `INSERT INTO users (name, email, password_hash, role) VALUES ('Dup', upper($1), 'hash', 'Client')`,
      [world.clients.acme.email],
      23505,
      /email/,
    );

    const product = await createProduct(world.admin.api, { sku: `CASE-${Date.now()}` });
    await expectSqlError(
      `INSERT INTO products (sku, name, unit_price) VALUES (lower($1), 'Duplicate', 1.00)`,
      [product.sku],
      23505,
      /sku/,
    );
  });

  it('allows an email to be reused after the account is soft-deleted', async () => {
    const email = `reusable-${Date.now()}@test.dev`;
    await query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ('First', $1, 'hash', 'Client')`,
      [email],
    );
    await query(`UPDATE users SET deleted_at = now() WHERE lower(email) = lower($1)`, [email]);

    await query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ('Second', $1, 'hash', 'Client')`,
      [email],
    );

    assert.equal(
      await scalar('SELECT count(*)::int FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL', [email]),
      1,
    );
  });

  it('protects referenced records from hard deletion', async () => {
    // A manager accountable for a warehouse cannot simply be deleted.
    await expectSqlError(
      `DELETE FROM users WHERE id = $1`,
      [world.managers.nairobi.id],
      ['23503', '23001'],
      /manager_id/,
    );

    // Neither can a warehouse that still holds stock.
    await expectSqlError(
      `DELETE FROM warehouses WHERE id = $1`,
      [world.warehouses.nairobi.id],
      ['23503', '23001'],
      /warehouse/,
    );
  });

  it('requires every order line to name a fulfilling warehouse', async () => {
    // Guarantee a valid order to attach the malformed line to.
    const order = await world.clients.acme.api.post('/api/orders', {
      items: [
        { product_id: world.products.cable.id, quantity: 1, warehouse_id: world.warehouses.dubai.id },
      ],
    });
    assert.equal(order.status, 201);
    const orderId = order.body.data.id;

    await expectSqlError(
      `INSERT INTO order_items (order_id, product_sku, product_name, quantity, price_at_purchase)
       VALUES ($1, 'X', 'X', 1, 1.00)`,
      [orderId],
      23502,
      /warehouse_id/,
    );
  });

  it('refuses two orders sharing an idempotency key', async () => {
    const key = crypto.randomUUID();
    const clientId = world.clients.acme.id;

    await query(
      `INSERT INTO orders (order_number, client_id, total_amount, idempotency_key)
       VALUES ($1, $2, 0, $3)`,
      [`TMP-${Date.now()}`, clientId, key],
    );

    await expectSqlError(
      `INSERT INTO orders (order_number, client_id, total_amount, idempotency_key)
       VALUES ($1, $2, 0, $3)`,
      [`TMP2-${Date.now()}`, clientId, key],
      23505,
      /idempotency/,
    );
  });

  it('requires a reason before an order may be marked cancelled', async () => {
    const orderId = await scalar("SELECT id FROM orders WHERE status = 'Pending' LIMIT 1");

    await expectSqlError(
      `UPDATE orders SET status = 'Cancelled' WHERE id = $1`,
      [orderId],
      23514,
      /cancel_reason/,
    );
  });

  it('allows only one warehouse per manager', async () => {
    await expectSqlError(
      `UPDATE warehouses SET manager_id = $1 WHERE id = $2`,
      [world.managers.nairobi.id, world.warehouses.dubai.id],
      23505,
      /manager/,
    );
  });

  it('stores money as exact NUMERIC and time as TIMESTAMPTZ', async () => {
    const columns = await query(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE (table_name = 'orders' AND column_name IN ('total_amount', 'created_at'))
           OR (table_name = 'products' AND column_name = 'unit_price')
           OR (table_name = 'inventory_transactions' AND column_name = 'created_at')`,
    );

    const byKey = new Map(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));

    assert.equal(byKey.get('orders.total_amount').data_type, 'numeric');
    assert.equal(Number(byKey.get('orders.total_amount').numeric_precision), 14);
    assert.equal(Number(byKey.get('orders.total_amount').numeric_scale), 2);

    assert.equal(byKey.get('products.unit_price').data_type, 'numeric');
    assert.equal(Number(byKey.get('products.unit_price').numeric_scale), 2);

    // Not timestamp-without-time-zone: "revenue today" must not depend on the
    // server's locale.
    assert.equal(byKey.get('orders.created_at').data_type, 'timestamp with time zone');
    assert.equal(byKey.get('inventory_transactions.created_at').data_type, 'timestamp with time zone');
  });

  it('indexes every foreign key that is queried by', async () => {
    const { rows } = await query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
    const names = new Set(rows.map((row) => row.indexname));

    for (const expected of [
      'inventory_warehouse_idx',
      'inventory_product_idx',
      'order_items_order_idx',
      'order_items_product_idx',
      'order_items_warehouse_idx',
      'orders_client_created_idx',
      'orders_status_created_idx',
      'warehouses_manager_idx',
      'inventory_transactions_stock_idx',
      'user_warehouses_warehouse_idx',
    ]) {
      assert.ok(names.has(expected), `missing index ${expected} (Postgres does not create these automatically)`);
    }
  });

  it('resolves the reorder threshold per warehouse, falling back to the product', async () => {
    const warehouse = await world.warehouses.dubai.id;
    const product = await createProduct(world.admin.api, { reorder_level: 10, unit_price: '5.00' });
    await receiveStock(world.admin.api, { warehouseId: warehouse, productId: product.id, quantity: 8 });

    // 8 <= 10 via the product fallback, so it is low stock.
    const fallback = await query(
      `SELECT effective_reorder_level FROM low_stock WHERE product_id = $1 AND warehouse_id = $2`,
      [product.id, warehouse],
    );
    assert.equal(fallback.rowCount, 1);
    assert.equal(fallback.rows[0].effective_reorder_level, 10);

    // A stricter per-warehouse threshold of 5 makes the same quantity acceptable.
    await query(`UPDATE inventory SET reorder_level = 5 WHERE product_id = $1 AND warehouse_id = $2`, [
      product.id,
      warehouse,
    ]);

    const overridden = await query(
      `SELECT 1 FROM low_stock WHERE product_id = $1 AND warehouse_id = $2`,
      [product.id, warehouse],
    );
    assert.equal(overridden.rowCount, 0, 'the per-warehouse override must win over the product default');
  });

  it('keeps the ledger consistent with the quantity it explains', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = await createProduct(world.admin.api, { reorder_level: 0, unit_price: '3.00' });
    await receiveStock(world.admin.api, { warehouseId, productId: product.id, quantity: 12 });

    const order = await world.clients.acme.api.post('/api/orders', {
      items: [{ product_id: product.id, quantity: 5, warehouse_id: warehouseId }],
    });
    assert.equal(order.status, 201, JSON.stringify(order.body));

    const cancelled = await world.clients.acme.api.post(`/api/orders/${order.body.data.id}/cancel`, {
      reason: 'Ledger consistency check',
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

    // Sum of every movement for this product must equal the stored quantity.
    const ledgerSum = await scalar(
      `SELECT COALESCE(sum(delta), 0)::int FROM inventory_transactions
        WHERE warehouse_id = $1 AND product_id = $2`,
      [warehouseId, product.id],
    );
    const quantity = await scalar(
      `SELECT quantity FROM inventory WHERE warehouse_id = $1 AND product_id = $2`,
      [warehouseId, product.id],
    );

    assert.equal(ledgerSum, quantity, 'stock must be fully explained by its ledger');
    assert.equal(quantity, 12);
  });
});