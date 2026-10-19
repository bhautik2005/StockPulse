import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as xlsx from 'xlsx';

import { parseAndValidateProductsFile } from '../src/modules/products/products.importer.js';

describe('Unit :: parseAndValidateProductsFile', () => {
  it('throws for invalid file extensions', () => {
    assert.throws(
      () => parseAndValidateProductsFile(Buffer.from('test'), 'image.png'),
      (err) => err.code === 'INVALID_FILE_TYPE',
    );
  });

  it('throws for empty file', () => {
    assert.throws(
      () => parseAndValidateProductsFile(Buffer.from(''), 'test.csv'),
      (err) => err.code === 'EMPTY_FILE' || err.code === 'CORRUPTED_FILE',
    );
  });

  it('throws for missing required column headers', () => {
    const csv = 'category,reorder_level\nElectronics,10';
    assert.throws(
      () => parseAndValidateProductsFile(Buffer.from(csv), 'test.csv'),
      (err) => err.code === 'MISSING_REQUIRED_COLUMNS',
    );
  });

  it('parses valid CSV correctly with case-insensitive and aliased headers', () => {
    const csv = [
      'Product SKU,Product Name,Category,Price,Reorder Level',
      'SKU-001,Widget A,Gadgets,19.99,15',
      'SKU-002,Widget B,Gadgets,$24.50,',
    ].join('\n');

    const result = parseAndValidateProductsFile(Buffer.from(csv), 'test.csv');
    assert.equal(result.totalProcessed, 2);
    assert.equal(result.validRows.length, 2);
    assert.equal(result.errors.length, 0);

    assert.equal(result.validRows[0].sku, 'SKU-001');
    assert.equal(result.validRows[0].name, 'Widget A');
    assert.equal(result.validRows[0].unitPrice, '19.99');
    assert.equal(result.validRows[0].reorderLevel, 15);

    // Default reorder level 10
    assert.equal(result.validRows[1].unitPrice, '24.50');
    assert.equal(result.validRows[1].reorderLevel, 10);
  });

  it('validates rows and reports row-specific errors', () => {
    const csv = [
      'sku,name,category,unit_price,reorder_level',
      'SKU-1,Valid Item,Tools,15.00,10',        // Row 2 - valid
      ',Missing SKU,Tools,15.00,10',             // Row 3 - missing sku
      'SKU-INVALID!,Bad SKU chars,Tools,15.00,10', // Row 4 - bad sku
      'SKU-3,,Tools,15.00,10',                   // Row 5 - missing name
      'SKU-4,Bad Price,Tools,invalid,10',        // Row 6 - invalid price
      'SKU-5,Bad Price 2,Tools,-10.00,10',       // Row 7 - negative price
      'SKU-6,Bad Reorder,Tools,10.00,-5',        // Row 8 - negative reorder level
      'SKU-1,Duplicate In File,Tools,20.00,10',  // Row 9 - duplicate of row 2
    ].join('\n');

    const result = parseAndValidateProductsFile(Buffer.from(csv), 'test.csv');
    assert.equal(result.totalProcessed, 8);
    assert.equal(result.validRows.length, 1);
    assert.equal(result.errors.length, 7);

    const errorRows = result.errors.map((e) => e.row);
    assert.deepEqual(errorRows, [3, 4, 5, 6, 7, 8, 9]);

    assert.match(result.errors[0].error, /Missing mandatory SKU/i);
    assert.match(result.errors[1].error, /only contain letters/i);
    assert.match(result.errors[2].error, /Missing mandatory name/i);
    assert.match(result.errors[3].error, /valid non-negative number/i);
    assert.match(result.errors[4].error, /valid non-negative number/i);
    assert.match(result.errors[5].error, /non-negative integer/i);
    assert.match(result.errors[6].error, /Duplicate SKU/i);
  });

  it('parses valid XLSX file correctly', () => {
    const wb = xlsx.utils.book_new();
    const wsData = [
      ['sku', 'name', 'category', 'unit_price', 'reorder_level'],
      ['XLS-001', 'Keyboard', 'Electronics', 45.0, 5],
      ['XLS-002', 'Mouse', 'Electronics', 25.5, 10],
    ];
    const ws = xlsx.utils.aoa_to_sheet(wsData);
    xlsx.utils.book_append_sheet(wb, ws, 'Products');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const result = parseAndValidateProductsFile(buffer, 'import.xlsx');
    assert.equal(result.totalProcessed, 2);
    assert.equal(result.validRows.length, 2);
    assert.equal(result.errors.length, 0);
  });

  it('parses quantity / stock column if provided in file', () => {
    const csv = [
      'sku,name,category,unit_price,reorder_level,quantity',
      'SKU-QTY-1,Item One,Tools,10.00,5,25',
      'SKU-QTY-2,Item Two,Tools,12.00,5,',
    ].join('\n');

    const result = parseAndValidateProductsFile(Buffer.from(csv), 'test.csv');
    assert.equal(result.totalProcessed, 2);
    assert.equal(result.validRows.length, 2);
    assert.equal(result.validRows[0].quantity, 25);
    assert.equal(result.validRows[1].quantity, undefined); // falls back to initial_stock
  });
});
