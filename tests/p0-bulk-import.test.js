/**
 * P0 :: Bulk Excel/CSV Product Import with Warehouse Routing and Inventory Creation.
 *
 * Verifies security, RBAC warehouse checks, transaction atomicity,
 * inventory registration, and ledger movements.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as xlsx from 'xlsx';

import { query, resetDatabase, startServer } from './helpers/harness.js';
import { createWorld, uniqueKey } from './helpers/fixtures.js';

describe('P0 :: bulk product import', () => {
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

  it('rejects unauthenticated requests with 401', async () => {
    const unauthClient = (await import('./helpers/api.js')).createApiClient(server.baseUrl);
    const form = new FormData();
    form.append('file', new Blob(['sku,name,unit_price\nSKU-A,Product A,10.00'], { type: 'text/csv' }), 'test.csv');
    form.append('warehouse_id', world.warehouses.dubai.id);
    const res = await unauthClient.post('/api/products/bulk-import', form);
    assert.equal(res.status, 401);
  });

  it('rejects Staff or Client roles with 403', async () => {
    const form = new FormData();
    form.append('file', new Blob(['sku,name,unit_price\nSKU-A,Product A,10.00'], { type: 'text/csv' }), 'test.csv');
    form.append('warehouse_id', world.warehouses.dubai.id);

    const staffRes = await world.staffNairobi.api.post('/api/products/bulk-import', form);
    assert.equal(staffRes.status, 403);

    const clientRes = await world.clientA.api.post('/api/products/bulk-import', form);
    assert.equal(clientRes.status, 403);
  });

  it('rejects request with missing file with 400', async () => {
    const form = new FormData();
    form.append('warehouse_id', world.warehouses.dubai.id);
    const res = await world.admin.api.post('/api/products/bulk-import', form);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'NO_FILE_UPLOADED');
  });

  it('rejects request with missing warehouse_id with 400', async () => {
    const form = new FormData();
    form.append('file', new Blob(['sku,name,unit_price\nSKU-A,Product A,10.00'], { type: 'text/csv' }), 'test.csv');
    const res = await world.admin.api.post('/api/products/bulk-import', form);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_WAREHOUSE_ID');
  });

  it('enforces RBAC: Manager cannot import into unassigned warehouse', async () => {
    const form = new FormData();
    form.append('file', new Blob(['sku,name,unit_price\nSKU-MGR,Product MGR,10.00'], { type: 'text/csv' }), 'test.csv');
    // Manager Lagos cannot import into Dubai warehouse
    form.append('warehouse_id', world.warehouses.dubai.id);

    const res = await world.managerLagos.api.post('/api/products/bulk-import', form);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'WAREHOUSE_FORBIDDEN');
  });

  it('allows Manager to import into their assigned warehouse', async () => {
    const sku = uniqueKey('MGR-OK');
    const form = new FormData();
    form.append(
      'file',
      new Blob([`sku,name,category,unit_price,reorder_level\n${sku},Manager Item,Tools,15.00,5`], {
        type: 'text/csv',
      }),
      'test.csv',
    );
    form.append('warehouse_id', world.warehouses.lagos.id);
    form.append('initial_stock', '12');

    const res = await world.managerLagos.api.post('/api/products/bulk-import', form);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.successCount, 1);
    assert.equal(res.body.data.warehouse.id, world.warehouses.lagos.id);

    // Verify inventory created in Lagos
    const { rows } = await query(
      'SELECT i.quantity FROM inventory i JOIN products p ON p.id = i.product_id WHERE p.sku = $1 AND i.warehouse_id = $2',
      [sku, world.warehouses.lagos.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quantity, 12);
  });

  it('successfully imports from CSV and registers initial stock and ledger entries', async () => {
    const sku1 = uniqueKey('CSV1');
    const sku2 = uniqueKey('CSV2');

    const csvContent = [
      'sku,name,category,unit_price,reorder_level',
      `${sku1},Test Product 1,Electronics,29.99,15`,
      `${sku2},Test Product 2,Hardware,49.50,20`,
    ].join('\n');

    const form = new FormData();
    form.append('file', new Blob([csvContent], { type: 'text/csv' }), 'products.csv');
    form.append('warehouse_id', world.warehouses.dubai.id);
    form.append('initial_stock', '25');

    const res = await world.admin.api.post('/api/products/bulk-import', form);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.totalProcessed, 2);
    assert.equal(res.body.data.successCount, 2);
    assert.equal(res.body.data.failedCount, 0);

    // Verify products table
    const { rows: prodRows } = await query('SELECT id, sku FROM products WHERE sku IN ($1, $2)', [
      sku1,
      sku2,
    ]);
    assert.equal(prodRows.length, 2);

    // Verify inventory table in Dubai warehouse
    const { rows: invRows } = await query(
      'SELECT product_id, quantity FROM inventory WHERE warehouse_id = $1 AND product_id = ANY($2::int[])',
      [world.warehouses.dubai.id, prodRows.map((p) => p.id)],
    );
    assert.equal(invRows.length, 2);
    assert.equal(invRows[0].quantity, 25);
    assert.equal(invRows[1].quantity, 25);

    // Verify ledger transactions
    const { rows: ledgerRows } = await query(
      'SELECT delta, reason FROM inventory_transactions WHERE warehouse_id = $1 AND product_id = ANY($2::int[])',
      [world.warehouses.dubai.id, prodRows.map((p) => p.id)],
    );
    assert.equal(ledgerRows.length, 2);
    assert.equal(ledgerRows[0].delta, 25);
    assert.equal(ledgerRows[0].reason, 'receipt');
  });

  it('successfully imports from XLSX file and creates inventory', async () => {
    const sku1 = uniqueKey('XLS1');
    const sku2 = uniqueKey('XLS2');

    const wb = xlsx.utils.book_new();
    const wsData = [
      ['Product SKU', 'Product Name', 'Category', 'Price', 'Reorder Level', 'Stock'],
      [sku1, 'Excel Product 1', 'Office', 15.0, 5, 30],
      [sku2, 'Excel Product 2', 'Office', 85.25, 12, 40],
    ];
    const ws = xlsx.utils.aoa_to_sheet(wsData);
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const form = new FormData();
    form.append(
      'file',
      new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'import.xlsx',
    );
    form.append('warehouse_id', world.warehouses.nairobi.id);

    const res = await world.admin.api.post('/api/products/bulk-import', form);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.totalProcessed, 2);
    assert.equal(res.body.data.successCount, 2);

    // Verify row-level quantity was respected (30 and 40)
    const { rows: invRows } = await query(
      'SELECT i.quantity FROM inventory i JOIN products p ON p.id = i.product_id WHERE p.sku IN ($1, $2) AND i.warehouse_id = $3 ORDER BY p.sku ASC',
      [sku1, sku2, world.warehouses.nairobi.id],
    );
    assert.equal(invRows.length, 2);
    assert.equal(invRows[0].quantity, 30);
    assert.equal(invRows[1].quantity, 40);
  });
});
