import { parseFileToRows } from '../src/modules/orders/bulkImport.service.js';

const csv = [
  'sku,name,unit_price,quantity',
  "''; DROP TABLE orders; --", 'Pwned Product', 10.00, 2,
].join('\n');

const result = parseFileToRows({ buffer: Buffer.from(csv), fileName: 'test.csv' });
console.log('Result:', JSON.stringify(result, null, 2));
