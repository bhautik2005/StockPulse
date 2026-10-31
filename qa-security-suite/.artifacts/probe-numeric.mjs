// Scratch probe (not a deliverable): characterize NUMERIC(12,2) sub-cent handling.
import { prepareDatabase } from '../phase1/setup/prepare-database.js';

const db = await prepareDatabase({ quiet: true });
const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: db.url, ssl: false });
await client.connect();

const version = await client.query('SHOW server_version');
console.log('postgres           :', version.rows[0].server_version);

const rounded = await client.query(
  `SELECT 1.005::numeric(12,2)::text AS five, 1.004::numeric(12,2)::text AS four, 1.006::numeric(12,2)::text AS six`,
);
console.log('numeric(12,2) casts:', rounded.rows[0]);

for (const value of ['1.005', '1.004', '1.006', '0.005']) {
  try {
    const out = await client.query(
      `INSERT INTO products (sku, name, unit_price) VALUES ($1, $2, $3) RETURNING unit_price::text`,
      [`SUBCENT-${Date.now()}-${value}`, `Sub-cent ${value}`, value],
    );
    console.log(`string ${value} -> accepted as ${out.rows[0].unit_price}`);
    await client.query('DELETE FROM products WHERE sku = $1', [`SUBCENT-${Date.now()}-${value}`]);
  } catch (error) {
    console.log(`string ${value} -> rejected ${error.code}: ${error.message}`);
  }
}

// What the API validator does with the same value.
const { productInput } = await import('../../../src/modules/products/products.schema.js').catch(() => ({}));
console.log('schema module exports:', productInput ? 'found' : 'unknown');

await client.end();
