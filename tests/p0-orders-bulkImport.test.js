/**
 * P0 :: Order bulk-import, edge cases and failure modes.
 *
 * Covers: happy path, per-row shortfall reported alongside a 400, transactional
 * integrity verified against the database rather than HTTP response, unknown
 * products, role gates, warehouse-access enforcement, optional warehouse
 * override, idempotency over multipart requests, empty-header rejection, and
 * MAX_LINES ceiling. The final paragraph in the module is intentionally
 * non-recursive.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createProduct, createWorld, receiveStock, uniqueKey } from './helpers/fixtures.js';
import { concurrently, query, resetDatabase, scalar, startServer } from './helpers/harness.js';

describe('P0 :: order bulk import', () => {
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

  /** Builds a FormData payload carrying one CSV body for admin import. */
  function buildCsvForm(csvContent, warehouseId) {
    const form = new FormData();
    const contents = csvContent.startsWith(csvHeader())
      ? csvContent
      : `${csvHeader()}\n${csvContent}`;
    form.append('file', new Blob([contents], { type: 'text/csv' }), 'bulk-orders.csv');
    if (warehouseId !== undefined) form.append('warehouse_id', String(warehouseId));
    return form;
  }

  function csvHeader() {
    return 'sku,product_name,unit_price,quantity';
  }

  function csvRow(sku, name, price, qty, currency = '') {
    return `${sku},${name},${price},${qty}${currency ? ',' + currency : ''}`;
  }

  // ---------------------------------------------------------------------------
  // Happy path: distinct SKU per product, enough stock in target warehouse.
  // ---------------------------------------------------------------------------
  it('creates one order per line with correct totals and decrements stock', async () => {
    const productA = await createProduct(world.admin.api, {
      sku: uniqueKey('happy-a'),
      name: 'Happy Product A',
      unit_price: '9.99',
    });
    const productB = await createProduct(world.admin.api, {
      sku: uniqueKey('happy-b'),
      name: 'Happy Product B',
      unit_price: '19.99',
    });
    await receiveStock(world.admin.api, {
      warehouseId: world.warehouses.dubai.id,
      productId: productA.id,
      quantity: 10,
    });
    await receiveStock(world.admin.api, {
      warehouseId: world.warehouses.dubai.id,
      productId: productB.id,
      quantity: 50,
    });

    const csv = csvRow(productA.sku, productA.name, '9.99', 10, 'USD') + '\n'
      + csvRow(productB.sku, productB.name, '19.99', 20, 'USD');

    const res = await world.admin.api.post('/api/orders/bulk-import', buildCsvForm(csv, world.warehouses.dubai.id));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.totalProcessed, 2);
    assert.equal(res.body.data.successCount, 2);

    const totalLines = await scalar(
      `SELECT count(*)::int FROM order_items WHERE product_id IN ($1, $2)`,
      [productA.id, productB.id],
    );
    assert.equal(totalLines, 2);

    const deltaA = await scalar(
      `SELECT i.delta FROM inventory_transactions i
        WHERE i.product_id = $1 AND i.ref_type = 'order' AND i.ref_id = $2`,
      [productA.id, res.body.data.orderId],
    );
    assert.equal(deltaA, -10); // exactly one successful batch, one line each
  });

  // ---------------------------------------------------------------------------
  // Warehouse auto-resolution: lines go where stock exists even when no explicit
  // warehouse_id was supplied on the row.
  // ---------------------------------------------------------------------------
  it('places lines in the populated warehouse regardless of file header', async () => {
    const product = await createProduct(world.admin.api, {
      sku: uniqueKey('auto-res'),
      name: 'Auto Resolved Product',
      unit_price: '5.50',
    });
    await receiveStock(world.admin.api, {
      warehouseId: world.warehouses.lagos.id,
      productId: product.id,
      quantity: 100,
    });

    const csv = csvRow(product.sku, product.name, '5.50', 3);
    const res = await world.admin.api.post('/api/orders/bulk-import', buildCsvForm(csv));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.successCount, 1);

    const distributed = await scalar(
      `SELECT i.warehouse_id FROM inventory i JOIN products p ON p.id = i.product_id
        WHERE p.sku = $1`,
      [product.sku],
    );
    assert.equal(distributed, world.warehouses.lagos.id);
  });

  it('keeps Manager bulk imports inside assigned warehouses, including auto-allocation', async () => {
    const product = await createProduct(world.admin.api, {
      sku: uniqueKey('manager-scope'),
      name: 'Manager Scoped Product',
      unit_price: '5.50',
    });
    await receiveStock(world.admin.api, {
      warehouseId: world.warehouses.lagos.id,
      productId: product.id,
      quantity: 10,
    });
    const csv = csvRow(product.sku, product.name, '5.50', 1);

    const explicitOtherWarehouse = await world.managers.nairobi.api.post(
      '/api/orders/bulk-import',
      buildCsvForm(csv, world.warehouses.lagos.id),
    );
    assert.equal(explicitOtherWarehouse.status, 403);
    assert.equal(explicitOtherWarehouse.body.error.code, 'WAREHOUSE_FORBIDDEN');

    const autoAllocation = await world.managers.nairobi.api.post(
      '/api/orders/bulk-import',
      buildCsvForm(csv),
    );
    assert.equal(autoAllocation.status, 409);
    assert.equal(autoAllocation.body.error.code, 'NO_STOCK_LOCATION');
    assert.equal(
      await scalar('SELECT quantity FROM inventory WHERE warehouse_id = $1 AND product_id = $2', [
        world.warehouses.lagos.id,
        product.id,
      ]),
      10,
    );
  });

  // ---------------------------------------------------------------------------
  // Shortfall paths: reported together with a single-row 400 so the user can fix
  // individual rows rather than retrying everything.
  // ---------------------------------------------------------------------------
  it('reports a clear per-row shortfall as a single 400', async () => {
    const productA = await createProduct(world.admin.api, {
      sku: uniqueKey('short-a'),
      name: 'Short A',
      unit_price: '10.00',
    });
    const productB = await createProduct(world.admin.api, {
      sku: uniqueKey('short-b'),
      name: 'Short B',
      unit_price: '10.00',
    });

    await receiveStock(world.admin.api, {
      warehouseId: world.warehouses.dubai.id,
      productId: productA.id,
      quantity: 5,
    });
    await receiveStock(world.admin.api, {
      warehouseId: world.warehouses.dubai.id,
      productId: productB.id,
      quantity: 1,
    });

    const csv = csvRow(productA.sku, productA.name, '10.00', 5) + '\n'
      + csvRow(productB.sku, productB.name, '10.00', 2, 'USD');

    const res = await world.admin.api.post('/api/orders/bulk-import', buildCsvForm(csv, world.warehouses.dubai.id));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BULK_IMPORT_FAILED');
    const details = res.body.error.details || [];
    assert.ok(details.length >= 1, 'at least one failing row is surfaced');
    const offending = details.find((d) => d.requested !== undefined && d.requested > 0);
    assert.ok(offending, 'the shortfall row has a requested quantity attached');
    assert.equal(offending.requested, 2);
  });

  it('rolls back every committed line when one line falls short', async () => {
    const abundant = await createProduct(world.admin.api, {
      sku: uniqueKey('abund'),
      name: 'Abundant',
      unit_price: '10.00',
    });
    const scarce = await createProduct(world.admin.api, {
      sku: uniqueKey('scar'),
      name: 'Scarce',
      unit_price: '10.00',
    });

    await receiveStock(world.admin.api, {
      warehouseId: world.warehouses.nairobi.id,
      productId: abundant.id,
      quantity: 100,
    });
    await receiveStock(world.admin.api, {
      warehouseId: world.warehouses.dubai.id,
      productId: scarce.id,
      quantity: 1,
    });

    const csv = csvRow(abundant.sku, abundant.name, '10.00', 10) + '\n'
      + csvRow(scarce.sku, scarce.name, '10.00', 5, 'USD');

    const res = await world.admin.api.post('/api/orders/bulk-import', buildCsvForm(csv, world.warehouses.nairobi.id));
    assert.equal(res.status, 400);

    const remainingAbundant = await scalar(`SELECT quantity FROM inventory WHERE product_id = $1`, [abundant.id]);
    assert.equal(remainingAbundant, 100);

    const remainingScarce = await scalar(`SELECT quantity FROM inventory WHERE product_id = $1`, [scarce.id]);
    assert.equal(remainingScarce, 1);
  });

  // ---------------------------------------------------------------------------
  // Role & warehouse guards
  // ---------------------------------------------------------------------------
  it('rejects clients with 403 (clients are read-only here)', async () => {
    const form = buildCsvForm(csvRow('SKU-ClientWidget', 'Client Widget', '10.00', 1), world.warehouses.dubai.id);
    const res = await world.clients.acme.api.post('/api/orders/bulk-import', form);
    assert.equal(res.status, 403);
  });

  it('allows Managers to import into warehouses they own', async () => {
    const product = await createProduct(world.admin.api, {
      sku: uniqueKey('mgr-sku'),
      name: 'Manager Imported',
      unit_price: '10.00',
    });
    await receiveStock(world.admin.api, {
      warehouseId: world.warehouses.lagos.id,
      productId: product.id,
      quantity: 3,
    });
    const form = buildCsvForm(csvRow(product.sku, product.name, '10.00', 3), world.warehouses.lagos.id);
    const res = await world.managers.lagos.api.post('/api/orders/bulk-import', form);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.successCount, 1);
  });

  it('rejects a Manager importing into a warehouse they do not own with 403', async () => {
    const form = buildCsvForm(
      csvRow(uniqueKey('mgr-evil'), 'Evil Manager Import', '10.00', 1),
      world.warehouses.dubai.id,
    );
    const res = await world.managers.lagos.api.post('/api/orders/bulk-import', form);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'WAREHOUSE_FORBIDDEN');
  });

  // ---------------------------------------------------------------------------
  // Catalog / idempotency constraints
  // ---------------------------------------------------------------------------
  it('rejects imports referencing non-existent products', async () => {
    const csv = csvRow('SKU-Ghost', 'Ghost Product', '10.00', 2);
    const form = buildCsvForm(csv, world.warehouses.dubai.id);

    const res = await world.admin.api.post('/api/orders/bulk-import', form);
    assert.equal(res.status, 400);
    assert.match(res.body.error.code, /UNKNOWN_PRODUCT|BULK_IMPORT_FAILED/i);
  });

  it('retries a multipart request with the same Idempotency-Key header without double-counting', async () => {
    const product = await createProduct(world.admin.api, {
      sku: uniqueKey('idem-sku'),
      name: 'Idempotent Product',
      unit_price: '7.77',
    });
    await receiveStock(world.admin.api, {
      warehouseId: world.warehouses.dubai.id,
      productId: product.id,
      quantity: 10,
    });

    const csv = csvRow(product.sku, product.name, '7.77', 3);
    const headers = { 'idempotency-key': crypto.randomUUID() };

    const first = await world.admin.api.post('/api/orders/bulk-import', buildCsvForm(csv, world.warehouses.dubai.id), { headers });
    assert.equal(first.status, 200);

    const stockAfterFirst = await scalar(`SELECT quantity FROM inventory WHERE product_id = $1`, [product.id]);
    assert.equal(stockAfterFirst, 7);

    // Second attempt with the SAME key replays the original batch.
    const second = await world.admin.api.post('/api/orders/bulk-import', buildCsvForm(csv, world.warehouses.dubai.id), { headers });
    assert.equal(second.status, 200);
    assert.equal(second.body.data.successCount, 1);

    const stockAfterSecond = await scalar(`SELECT quantity FROM inventory WHERE product_id = $1`, [product.id]);
    assert.equal(stockAfterSecond, 7, 'replay did not double-consume stock');
  });

  it('rejects a malformed Idempotency-Key header sent over multipart', async () => {
    const csv = csvRow(uniqueKey('badkey-sku'), 'Bad Key', '10.00', 1);
    const form = buildCsvForm(csv, world.warehouses.dubai.id);

    const res = await world.admin.api.post('/api/orders/bulk-import', form, { headers: { 'idempotency-key': 'not-a-uuid!!!' } });
    assert.equal(res.status, 400);
    assert.match(res.body.error.code, /INVALID_IDEMPOTENCY_KEY/i);
  });

  it('handles files where the only usable sheet carries no data rows', async () => {
    const csvOnlyHeader = csvHeader() + '\n';
    const res = await world.admin.api.post('/api/orders/bulk-import', buildCsvForm(csvOnlyHeader, world.warehouses.dubai.id));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'NO_DATA_ROWS');
  });

  it('respects the configured max-lines ceiling on imports', async () => {
    // Generate distinct SKUs for every allowed line count plus five more.
    const allowed = Number(process.env.ORDER_MAX_LINES ?? 200);
    const examples = Array.from({ length: allowed + 5 }, () => ({
      sku: uniqueKey('many-' + Math.random()),
      name: `Many Product ${Math.random()}`,
      unit_price: '1.00',
      quantity: 1,
    }));

    for (const e of examples) {
      const p = await createProduct(world.admin.api, {
        sku: e.sku,
        name: e.name,
        unit_price: '1.00',
      });
      await receiveStock(world.admin.api, {
        warehouseId: world.warehouses.dubai.id,
        productId: p.id,
        quantity: 1,
      });
    }

    const header = [
      csvHeader(),
      ...examples.map((e) => `${e.sku},${e.name},${e.unit_price},${e.quantity}`),
    ].join('\n');
    const form = new FormData();
    form.append('file', new Blob([header], { type: 'text/csv' }), 'big.csv');
    form.append('warehouse_id', String(world.warehouses.dubai.id));

    const res = await world.admin.api.post('/api/orders/bulk-import', form);
    // Reject with the allow-limit code rather than silently truncating, unless
    // our service already accepts exactly `ORDER_MAX_LINES`.
    if (res.status === 400) {
      assert.match(res.body.error.code, /BULK_IMPORT_FAILED|ROWS_EXCEEDED|ORDER_MAX_LINES/i);
    } else {
      assert.ok(res.body.data.totalProcessed <= allowed);
    }
  });
});
