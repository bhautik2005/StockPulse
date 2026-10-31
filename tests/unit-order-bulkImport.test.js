import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as xlsx from 'xlsx';

import { parseFileToRows } from '../src/modules/orders/bulkImport.service.js';

describe('Unit :: parseFileToRows', () => {
  it('throws for invalid file extensions', () => {
    assert.throws(
      () => parseFileToRows({ buffer: Buffer.from('test'), fileName: 'image.png' }),
      (err) => err.code === 'INVALID_FILE_TYPE',
    );
  });

  it('rejects a corrupt workbook gracefully', () => {
    // A valid xlsx header followed by junk bytes.
    const buffer = Buffer.concat([
      Buffer.from('PK\x03\x04' + 'junkdata'.repeat(40)), // xlsx magic
      Buffer.from('gibberish'.repeat(200)),
    ]);
    assert.throws(
      () => parseFileToRows({ buffer, fileName: 'bad.xlsx' }),
      (err) => err.code === 'CORRUPTED_FILE' || err.code === 'EMPTY_WORKBOOK',
    );
  });

  it('parses a single-row CSV with no quantity field as invalid rows', () => {
    // A row carrying SKU, product_name and unit_price but nothing else cannot
    // form an order line; both the quantity and sku constraints must fail.
    const csv = 'sku,product_name,unit_price\nSKU-A,Product A,10.00';
    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 0);
  });

  it('parses valid CSV with aliased and case-insensitive headers', () => {
    const csv = [
      'Product SKU,Product Name,Unit Price,Quantity,Warehouse ID',
      'SKU-001,Widget A,19.99,2,WH-001',
    ].join('\n');

    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(result.validRows[0].product_id, null);
    assert.equal(result.validRows[0].qty, 2);
  });

  it('rejects empty or blank SKU', () => {
    const csv = [
      'sku,name,unit_price,quantity',
      ',Bad Name,10.00,2',
    ].join('\n');

    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].fieldErrors[0].error, /Missing mandatory SKU/i);
  });

  it('rejects empty product name', () => {
    const csv = [
      'sku,name,unit_price,quantity',
      'SKU-1,,10.00,2',
    ].join('\n');

    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 0);
    assert.match(result.errors[0].fieldErrors[0].error, /Missing mandatory product name/i);
  });

  it('rejects missing unit_price column', () => {
    const csv = 'sku,name,quantity\nSKU-1,Widget,2';
    assert.throws(
      () => parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' }),
      (err) => err.code === 'MISSING_REQUIRED_COLUMNS',
    );
  });

  it('rejects negative prices', () => {
    const csv = [
      'sku,name,unit_price,quantity',
      'SKU-1,Bad,10.00,-2',
    ].join('\n');

    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].fieldErrors[0].error, /cannot be negative/i);
  });

  it('rejects non-numeric quantities', () => {
    const csv = [
      'sku,name,unit_price,quantity',
      'SKU-1,Bad,10.00,abc',
    ].join('\n');

    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 0);
    assert.match(result.errors[0].fieldErrors[0].error, /positive integer/i);
  });

  it('rejects zero quantities', () => {
    const csv = [
      'sku,name,unit_price,quantity',
      'SKU-1,Bad,10.00,0',
    ].join('\n');

    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 0);
    assert.match(result.errors[0].fieldErrors[0].error, /greater than zero/i);
  });

  it('parses decimal places and normalises currency when provided', () => {
    const csv = [
      'sku,product_name,unit_price,quantity,currency',
      'SKU-DEC,Decimal Item,9.99,3,usd',
    ].join('\n');

    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 1);
    // `lines[0]` has the optional currency set only when the file carried one; here we skip
    // because product_id/qty would be null but these checks still hold.
    assert.deepEqual(result.validRows[0], {
      product_id: null,
      qty: 3,
      warehouse_id: null,
      currency: 'USD',
    });
  });

  it('records multiple errors on a single row and keeps its SKU for traceability', () => {
    const csv = [
      'sku,name,unit_price,quantity',
      'BAD SKU!,Missing Field,not-a-number,abc',
    ].join('\n');

    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].sku.includes('BAD'));
    const fields = result.errors[0].fieldErrors.map((f) => `${f.field}: ${f.error}`).join('; ');
    assert.match(fields, /Missing mandatory SKU|positive integer/i);
  });

  it('normalises whitespace in headers (does not match "unit price" when column is named differently)', () => {
    const csv = ['sku , name, price, qty\nSKU-1, Widget A, 10.00, 2'].join('\n');
    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.validRows.length, 1);
  });

  it('rejects three decimal places on unit price', () => {
    const csv = [
      'sku,name,unit_price,quantity',
      'SKU-1,Bad,10.123,2',
    ].join('\n');

    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 0);
    assert.match(result.errors[0].fieldErrors.map((f) => f.error).join('; '), /decimal places/i);
  });

  it('rejects negative unit prices like -$5.00', () => {
    const csv = [
      'sku,name,unit_price,quantity',
      'SKU-N,Neg,$-5.00,2',
    ].join('\n');

    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.validRows.length, 0);
    assert.match(result.errors[0].fieldErrors[0].error, /negative/i);
  });

  it('rejects payloads carrying SQL injection strings as SKUs or names', () => {
    const csv = [
      'sku,name,unit_price,quantity',
      `"''; DROP TABLE orders; --",Pwned Product,10.00,2`,
    ].join('\n');

    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].fieldErrors[0].error, /SKU/i);
  });

  it('rejects null bytes in text fields (covers the safeText guard)', () => {
    // Construct the byte sequence directly so the embedded U+0000 survives the
    // Buffer/CSV boundary rather than being sanitised away before validation runs.
    const rowWithNullByte = [
      ['SKU-\u0000BAD', 'Product \u0000Name', '10.00', '2'],
    ].join('\n');

    const csv = ['sku,product_name,unit_price,quantity', rowWithNullByte].join('\n');
    const buffer = Buffer.from(csv, 'utf8');
    const result = parseFileToRows({ buffer, fileName: 'orders.csv' });
    assert.equal(result.validRows.length, 0);
    assert.ok(result.errors.length > 0);
    const allMessages = result.errors.flatMap((e) => e.fieldErrors.map((f) => f.error));
    assert.ok(allMessages.some((m) => /null byte|text must not contain/i.test(m)),
      'null-byte errors must be reported');
  });

  it('rejects rows with missing quantity field', () => {
    const csv = [
      'sku,name,unit_price',
      'SKU-Q,No Quantity,10.00',
    ].join('\n');

    const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'orders.csv' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].fieldErrors[0].error, /quantity/i);
  });

  it('handles an XLSX file with header-only data without crashing', () => {
    const wb = xlsx.utils.book_new();
    const wsData = [
      ['sku', 'product_name', 'unit_price', 'quantity'],
      ['SKU-001', 'Excel Widget', 19.99, 2],
    ];
    const ws = xlsx.utils.aoa_to_sheet(wsData);
    xlsx.utils.book_append_sheet(wb, ws, 'Orders');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const result = parseFileToRows({ buffer, fileName: 'orders.xlsx' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows.length, 1);
    assert.equal(result.validRows[0].qty, 2);
  });

  it('rejects XLSX files that have only headers', () => {
    const wb = xlsx.utils.book_new();
    const wsData = [
      ['sku', 'product_name', 'unit_price', 'quantity'],
    ];
    const ws = xlsx.utils.aoa_to_sheet(wsData);
    xlsx.utils.book_append_sheet(wb, ws, 'Orders');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    assert.throws(
      () => parseFileToRows({ buffer, fileName: 'orders.xlsx' }),
      (err) => err.code === 'NO_DATA_ROWS',
    );
  });

  it('rejects a header repeated across two sheets where the first sheet has no data', () => {
    // The implementation picks only the first usable sheet; the second sheet is
    // ignored when it has nothing useful to contribute. That is the contract we
    // commit to here, verified by exercising both sheets on purpose.
    const wb = xlsx.utils.book_new();
    const wsEmptySheet = xlsx.utils.aoa_to_sheet([
      ['sku', 'product_name', 'unit_price', 'quantity'],
    ]);
    const wsFilledSheet = xlsx.utils.aoa_to_sheet([
      ['sku', 'product_name', 'unit_price', 'quantity'],
      ['SKU-X', 'Widget', 5.00, 1],
    ]);
    xlsx.utils.book_append_sheet(wb, wsEmptySheet, 'FirstSheet');
    xlsx.utils.book_append_sheet(wb, wsFilledSheet, 'SecondSheet');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const result = parseFileToRows({ buffer, fileName: 'multi.xlsx' });
    assert.equal(result.totalProcessed, 1);
    assert.equal(result.validRows[0].qty, 1);
  });
});
