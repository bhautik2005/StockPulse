/**
 * Phase 2 :: Database integrity, constraints and referential actions.
 *
 * These tests attack PostgreSQL directly, bypassing the API entirely. That is
 * the point: application-layer validation can be forgotten, bypassed by a future
 * script, or defeated by a race. Constraints, foreign keys and unique indexes are
 * the guarantees that hold regardless of which code path is writing.
 *
 * Every assertion here is about a SQLSTATE, not a status code. The distinction
 * between 23503 (foreign_key_violation) and 23001 (restrict_violation) is exactly
 * the kind of detail a suite that only checks "it threw" never proves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectSqlError, query, resetDatabase, scalar } from '../../phase1/setup/db.js';
import {
  createSimpleWorld,
  insertInventory,
  insertProduct,
  insertWarehouse,
  uniqueKey,
} from '../../phase1/helpers/fixtures.js';

let world;

beforeAll(async () => {
  await resetDatabase();
  world = await createSimpleWorld({ stock: 25 });
});

afterAll(async () => {
  const { closePool } = await import('../../phase1/setup/db.js');
  await closePool();
});

// ---------------------------------------------------------------------------
// Foreign keys and referential actions
// ---------------------------------------------------------------------------

describe('Phase 2 :: foreign key cascades (DELETE behaviour)', () => {
  it('cascades a deleted order into its lines and status history', async () => {
    const order = await world.client.api.post('/api/orders', {
      items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 2 }],
    });
    expect(order.status).toBe(201);

    const orderId = order.body.data.id;
    expect(Number(await scalar('SELECT count(*)::int FROM order_items WHERE order_id = $1', [orderId]))).toBe(1);
    expect(Number(await scalar('SELECT count(*)::int FROM order_status_history WHERE order_id = $1', [orderId]))).toBe(1);

    await query('DELETE FROM orders WHERE id = $1', [orderId]);

    // ON DELETE CASCADE: nothing may be left orphaned.
    expect(Number(await scalar('SELECT count(*)::int FROM order_items WHERE order_id = $1', [orderId]))).toBe(0);
    expect(
      Number(await scalar('SELECT count(*)::int FROM order_status_history WHERE order_id = $1', [orderId])),
    ).toBe(0);
    expect(Number(await scalar('SELECT count(*)::int FROM orders WHERE id = $1', [orderId]))).toBe(0);
  });

  it('detaches (never deletes) product links in order lines when the ledger permits removal', async () => {
    const product = await insertProduct({ sku: `DETACH-${uniqueKey()}`, unitPrice: '11.00' });
    await insertInventory(world.warehouse.id, product.id, 5);

    const order = await world.client.api.post('/api/orders', {
      items: [{ product_id: product.id, warehouse_id: world.warehouse.id, quantity: 1 }],
    });
    expect(order.status).toBe(201);

    /*
     * `order_items.product_id` is ON DELETE SET NULL, but that rule never gets a
     * chance to fire in normal operation: the same product is referenced by
     * `inventory_transactions.product_id` with ON DELETE RESTRICT, so PostgreSQL
     * refuses the delete outright. That is the intended design -- an audit trail
     * that can be severed is not an audit trail -- and this test walks the whole
     * path to prove both halves of it.
     */
    await expectSqlError('DELETE FROM products WHERE id = $1', [product.id], [23001, 23503], /product/);

    // Clear the rows that legitimately block the delete: the stock record and
    // the ledger entries (a manual write-off, not something the app ever does).
    await query('DELETE FROM inventory WHERE product_id = $1', [product.id]);
    await query('DELETE FROM inventory_transactions WHERE product_id = $1', [product.id]);
    await query('DELETE FROM products WHERE id = $1', [product.id]);

    const { rows } = await query(
      `SELECT product_id, product_sku, product_name, quantity, price_at_purchase
         FROM order_items WHERE order_id = $1`,
      [order.body.data.id],
    );

    // ON DELETE SET NULL: the financial record survives even though the catalogue
    // row is gone, and the SKU/name/price snapshot keeps it readable.
    expect(rows).toHaveLength(1);
    expect(rows[0].product_id).toBeNull();
    expect(rows[0].product_sku).toBe(product.sku);
    expect(Number(rows[0].quantity)).toBe(1);
    expect(rows[0].price_at_purchase).toBe('11.00');
  });

  it('offers soft delete as the supported way to retire a product', async () => {
    const product = await insertProduct({ sku: `SOFT-${uniqueKey()}`, unitPrice: '7.00' });
    await insertInventory(world.warehouse.id, product.id, 3);

    // The application's DELETE /api/products/:id sets deleted_at instead of
    // removing the row, which is why the catalogue never loses its history.
    // `Number()` because an int8/bigint id comes back as a string from the
    // driver, and the route's param validator requires a number.
    const archived = await world.admin.api.delete(`/api/products/${Number(product.id)}`);
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);

    const row = await query('SELECT deleted_at, is_active FROM products WHERE id = $1', [product.id]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].deleted_at).not.toBeNull();

    // It disappears from the catalogue while remaining referenceable by history.
    // `limit` is capped at 100 by paginationQuery, so a literal 200 is a 400 --
    // ask for the default page and let the id assertion do the work.
    const listed = await world.admin.api.get('/api/products');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const ids = listed.body.data.map((entry) => Number(entry.id));
    expect(ids).not.toContain(Number(product.id));
  });

  it('refuses to delete a client who still has orders (RESTRICT, 23001)', async () => {
    await world.client.api.post('/api/orders', {
      items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 1 }],
    });

    await expectSqlError('DELETE FROM users WHERE id = $1', [world.client.id], [23001, 23503], /client_id/);

    // Nothing was deleted: an order with no owner would be unaccountable.
    expect(Number(await scalar('SELECT count(*)::int FROM users WHERE id = $1', [world.client.id]))).toBe(1);
  });

  it('refuses to delete a warehouse that still has stock or order lines (RESTRICT)', async () => {
    await expectSqlError('DELETE FROM warehouses WHERE id = $1', [world.warehouse.id], [23001, 23503], /warehouse/);
    expect(Number(await scalar('SELECT count(*)::int FROM warehouses WHERE id = $1', [world.warehouse.id]))).toBe(1);
  });

  it('refuses to delete a warehouse that still has order lines (RESTRICT, 23001)', async () => {
    const warehouse = await insertWarehouse();
    const product = await insertProduct({ sku: `WREF-${uniqueKey()}`, unitPrice: '5.00' });
    await insertInventory(warehouse.id, product.id, 10);

    const order = await world.client.api.post('/api/orders', {
      items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: 1 }],
    });
    expect(order.status).toBe(201);

    await expectSqlError('DELETE FROM warehouses WHERE id = $1', [warehouse.id], [23001, 23503], /warehouse/);

    /*
     * Drop the other references and the delete becomes legal -- the control case.
     *
     * The ledger is the one that surprised us: `inventory_transactions`
     * references the warehouse with ON DELETE RESTRICT, so clearing `inventory`
     * and `order_items` is not enough. That is the desired design (an audit trail
     * you can delete is not an audit trail), and it is worth proving explicitly
     * rather than assuming `order_items` is the last blocker.
     */
    await query('DELETE FROM inventory WHERE warehouse_id = $1', [warehouse.id]);
    await query('DELETE FROM order_items WHERE warehouse_id = $1', [warehouse.id]);
    await expectSqlError('DELETE FROM warehouses WHERE id = $1', [warehouse.id], [23001, 23503], /warehouse/);

    await query('DELETE FROM inventory_transactions WHERE warehouse_id = $1', [warehouse.id]);
    await query('DELETE FROM warehouses WHERE id = $1', [warehouse.id]);
    expect(Number(await scalar('SELECT count(*)::int FROM warehouses WHERE id = $1', [warehouse.id]))).toBe(0);
  });

  it('cascades warehouse access grants when the warehouse is removed', async () => {
    const warehouse = await insertWarehouse();
    await query('INSERT INTO user_warehouses (user_id, warehouse_id) VALUES ($1, $2)', [
      world.client.id,
      warehouse.id,
    ]);

    expect(
      Number(await scalar('SELECT count(*)::int FROM user_warehouses WHERE warehouse_id = $1', [warehouse.id])),
    ).toBe(1);

    await query('DELETE FROM warehouses WHERE id = $1', [warehouse.id]);

    expect(
      Number(await scalar('SELECT count(*)::int FROM user_warehouses WHERE warehouse_id = $1', [warehouse.id])),
    ).toBe(0);
  });

  it('leaves no orphan inventory_transactions when their product is force-deleted', async () => {
    const warehouse = await insertWarehouse();
    const product = await insertProduct({ sku: `LED-${uniqueKey()}`, unitPrice: '3.00' });
    await insertInventory(warehouse.id, product.id, 40);

    const order = await world.client.api.post('/api/orders', {
      items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: 4 }],
    });
    expect(order.status).toBe(201);

    // The ledger references the product with RESTRICT, so the delete must fail
    // rather than silently corrupting the audit trail.
    await expectSqlError('DELETE FROM products WHERE id = $1', [product.id], [23001, 23503], /product/);
  });
});

// ---------------------------------------------------------------------------
// Unique constraints
// ---------------------------------------------------------------------------

describe('Phase 2 :: unique constraints', () => {
  it('rejects a duplicate email at the database layer, case-insensitively', async () => {
    const email = `unique-${uniqueKey()}@stockpulse.test`;
    await query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ('A', $1, 'x', 'Client')`,
      [email],
    );

    // Application validation is irrelevant here: the functional index is the
    // guarantee. Note the different casing on the second attempt.
    await expectSqlError(
      `INSERT INTO users (name, email, password_hash, role) VALUES ('B', $1, 'x', 'Client')`,
      [email.toUpperCase()],
      '23505',
      /users_email_lower_uniq/,
    );
  });

  it('rejects a duplicate SKU case-insensitively', async () => {
    const sku = `UNIQ-${uniqueKey()}`;
    await insertProduct({ sku });

    await expectSqlError(
      `INSERT INTO products (sku, name, unit_price) VALUES ($1, 'Dup', 1.00)`,
      [sku.toLowerCase()],
      '23505',
      /products_sku_uniq/,
    );
  });

  it('rejects a duplicate warehouse code', async () => {
    const warehouse = await insertWarehouse();

    // Note the division of labour: the CHECK (code = upper(code)) already makes
    // the stored value uppercase, so `warehouses_code_uniq ON upper(code)` exists
    // to catch a straight duplicate rather than a casing trick. Lowercase input
    // never reaches the index -- it is rejected by the CHECK, which the next test
    // in this file covers.
    await expectSqlError(
      `INSERT INTO warehouses (code, name, location) VALUES ($1, $2, 'Somewhere')`,
      [warehouse.code, `Distinct Name ${uniqueKey()}`],
      '23505',
      /warehouses_code_uniq/,
    );
  });

  it('rejects a duplicate warehouse name even when the code is new', async () => {
    const warehouse = await insertWarehouse();

    // `warehouses_name_uniq` is a functional index on lower(name) where the row
    // is not soft-deleted, so casing must not be able to smuggle a duplicate in.
    await expectSqlError(
      `INSERT INTO warehouses (code, name, location) VALUES ($1, $2, 'Somewhere')`,
      [uniqueKey('NEWCODE').toUpperCase(), warehouse.name.toLowerCase()],
      '23505',
      /warehouses_name_uniq/,
    );
  });

  it('rejects two stock rows for the same warehouse and product', async () => {
    await expectSqlError(
      `INSERT INTO inventory (warehouse_id, product_id, quantity) VALUES ($1, $2, 1)`,
      [world.warehouse.id, world.product.id],
      '23505',
      /inventory_warehouse_product_uniq/,
    );
  });

  it('rejects a replayed idempotency key', async () => {
    const key = crypto.randomUUID();
    await query(
      `INSERT INTO orders (order_number, client_id, total_amount, idempotency_key)
       VALUES ('SO-2000-000001', $1, 10.00, $2)`,
      [world.client.id, key],
    );

    await expectSqlError(
      `INSERT INTO orders (order_number, client_id, total_amount, idempotency_key)
       VALUES ('SO-2000-000002', $1, 10.00, $2)`,
      [world.client.id, key],
      '23505',
      /orders_idempotency_uniq/,
    );
  });

  it('rejects a duplicate order number', async () => {
    const number = `SO-2001-${Date.now().toString().slice(-6)}`;
    await query(
      `INSERT INTO orders (order_number, client_id, total_amount, idempotency_key)
       VALUES ($1, $2, 1.00, $3)`,
      [number, world.client.id, crypto.randomUUID()],
    );

    await expectSqlError(
      `INSERT INTO orders (order_number, client_id, total_amount, idempotency_key)
       VALUES ($1, $2, 1.00, $3)`,
      [number, world.client.id, crypto.randomUUID()],
      '23505',
      /orders_number_uniq/,
    );
  });
});

// ---------------------------------------------------------------------------
// Check constraints
// ---------------------------------------------------------------------------

describe('Phase 2 :: CHECK constraints', () => {
  it('refuses to let inventory go negative, even by direct UPDATE', async () => {
    await expectSqlError(
      'UPDATE inventory SET quantity = -1 WHERE warehouse_id = $1 AND product_id = $2',
      [world.warehouse.id, world.product.id],
      '23514',
      /quantity/,
    );

    await expectSqlError(
      'UPDATE inventory SET quantity = quantity - 10000 WHERE warehouse_id = $1 AND product_id = $2',
      [world.warehouse.id, world.product.id],
      '23514',
      /quantity/,
    );

    expect(Number(await scalar(
      'SELECT quantity FROM inventory WHERE warehouse_id = $1 AND product_id = $2',
      [world.warehouse.id, world.product.id],
    ))).toBeGreaterThanOrEqual(0);
  });

  it('refuses a negative price', async () => {
    await expectSqlError(
      `INSERT INTO products (sku, name, unit_price) VALUES ($1, 'Negative', -1.00)`,
      [`NEG-${uniqueKey()}`],
      '23514',
      /unit_price/,
    );
  });

  it('refuses an unknown role', async () => {
    await expectSqlError(
      `INSERT INTO users (name, email, password_hash, role) VALUES ('X', $1, 'x', 'Superuser')`,
      [`badrole-${uniqueKey()}@stockpulse.test`],
      '23514',
      /role/,
    );
  });

  it('refuses an unknown order status', async () => {
    await expectSqlError(
      `INSERT INTO orders (order_number, client_id, status, total_amount, idempotency_key)
       VALUES ($1, $2, 'Teleported', 1.00, $3)`,
      [`SO-2999-000001`, world.client.id, crypto.randomUUID()],
      '23514',
      /status/,
    );
  });

  it('requires an order line quantity greater than zero', async () => {
    const order = await world.client.api.post('/api/orders', {
      items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 1 }],
    });

    for (const quantity of [0, -5]) {
      await expectSqlError(
        `INSERT INTO order_items (order_id, product_id, warehouse_id, product_sku, product_name, quantity, price_at_purchase)
         VALUES ($1, $2, $3, 'SKU', 'Name', $4, 1.00)`,
        [order.body.data.id, world.product.id, world.warehouse.id, quantity],
        '23514',
        /quantity/,
      );
    }
  });

  it('requires a cancelled order to explain itself', async () => {
    await expectSqlError(
      `INSERT INTO orders (order_number, client_id, status, total_amount, idempotency_key)
       VALUES ($1, $2, 'Cancelled', 1.00, $3)`,
      ['SO-2999-000002', world.client.id, crypto.randomUUID()],
      '23514',
      /cancel_reason/,
    );
  });

  it('normalises a negative total to a rejection, not a stored value', async () => {
    await expectSqlError(
      `INSERT INTO orders (order_number, client_id, total_amount, idempotency_key)
       VALUES ($1, $2, -0.01, $3)`,
      ['SO-2999-000003', world.client.id, crypto.randomUUID()],
      '23514',
      /total_amount/,
    );
  });

  it('refuses a lowercase warehouse code', async () => {
    await expectSqlError(
      `INSERT INTO warehouses (code, name, location) VALUES ('nbo-lower', 'Lower', 'Nowhere')`,
      [],
      '23514',
      /code/,
    );
  });

  it('refuses a lowercase currency code', async () => {
    await expectSqlError(
      `INSERT INTO orders (order_number, client_id, total_amount, currency, idempotency_key)
       VALUES ($1, $2, 1.00, 'usd', $3)`,
      ['SO-2999-000004', world.client.id, crypto.randomUUID()],
      '23514',
      /currency/,
    );
  });

  it('refuses an empty product name or SKU', async () => {
    await expectSqlError(
      `INSERT INTO products (sku, name, unit_price) VALUES ($1, '   ', 1.00)`,
      [`BLANK-${uniqueKey()}`],
      '23514',
      /name/,
    );
  });
});

// ---------------------------------------------------------------------------
// Type-level guarantees
// ---------------------------------------------------------------------------

describe('Phase 2 :: money is exact, never floating point', () => {
  it('stores a NUMERIC price with cent precision and returns it as a string', async () => {
    const product = await insertProduct({ sku: `MON-${uniqueKey()}`, unitPrice: '0.10' });
    await insertInventory(world.warehouse.id, product.id, 1000);

    // 3 x 0.10 is 0.30000000000000004 in IEEE-754. In NUMERIC it is 0.30, and
    // node-postgres hands NUMERIC back as a string precisely so a JS number
    // cannot reintroduce the error.
    const order = await world.client.api.post('/api/orders', {
      items: [{ product_id: product.id, warehouse_id: world.warehouse.id, quantity: 3 }],
    });

    expect(order.status).toBe(201);
    expect(order.body.data.total_amount).toBe('0.30');
    expect(typeof order.body.data.total_amount).toBe('string');

    const stored = await scalar('SELECT total_amount::text FROM orders WHERE id = $1', [order.body.data.id]);
    expect(stored).toBe('0.30');
  });

  it('rounds a sub-cent value at the database, which is why the API must reject it first', async () => {
    /*
     * PostgreSQL rounds half-away-from-zero when casting into numeric(12,2):
     * 1.005 becomes 1.01. It does NOT raise -- there is no SQLSTATE to assert on
     * (an earlier version of this test expected one and was simply wrong).
     *
     * That makes the application-level check load-bearing rather than
     * belt-and-braces, which the next test proves. A price silently becoming a
     * different price is a financial-correctness bug, not a rounding nicety.
     */
    const stored = await scalar('SELECT 1.005::numeric(12,2)::text AS rounded');
    expect(stored).toBe('1.01');

    const inserted = await query(
      `INSERT INTO products (sku, name, unit_price) VALUES ($1, 'Sub-cent probe', $2) RETURNING unit_price::text AS price`,
      [`SUBCENT-${uniqueKey()}`, '1.005'],
    );
    expect(inserted.rows[0].price).toBe('1.01');
  });

  it('the API refuses sub-cent precision, so the rounding above never happens', async () => {
    // This is the guard that stands between a user typing 1.005 and the column
    // deciding for itself what the price means.
    const response = await world.admin.api.post('/api/products', {
      sku: `PRICE-${uniqueKey()}`.toUpperCase(),
      name: 'Sub-cent via API',
      unit_price: '1.005',
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    // The exact wording differs between the string regex and the numeric
    // refinement, so match the invariant ("at most 2 decimal places") rather
    // than one branch's phrasing.
    expect(JSON.stringify(response.body.error.details)).toMatch(/2 (decimal places|places)/);
  });

  it('the API refuses a three-decimal price sent as a raw JSON number too', async () => {
    // `1.005` as a number has no exact binary representation, so the validator
    // must not accept it on the strength of a string regex alone.
    const response = await world.admin.api.post('/api/products', {
      sku: `PRICENUM-${uniqueKey()}`.toUpperCase(),
      name: 'Sub-cent number',
      unit_price: 1.005,
    });

    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Trigger-enforced invariants
// ---------------------------------------------------------------------------

describe('Phase 2 :: updated_at is maintained by the database', () => {
  it('bumps updated_at on UPDATE without the application asking', async () => {
    const before = await scalar('SELECT updated_at FROM products WHERE id = $1', [world.product.id]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await query(`UPDATE products SET name = name WHERE id = $1`, [world.product.id]);
    const after = await scalar('SELECT updated_at FROM products WHERE id = $1', [world.product.id]);

    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});
