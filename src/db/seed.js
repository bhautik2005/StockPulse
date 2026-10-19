/**
 * Demo data.
 *
 *   npm run seed
 *
 * Idempotent by design: re-running it will not duplicate users, warehouses,
 * products, stock or demo orders. It drives the real service layer (not raw
 * INSERTs) for stock receipts and orders, so a successful seed also proves the
 * application's own code paths work end to end.
 */
import { env, ROLES } from '../config/env.js';
import { hashPassword } from '../lib/password.js';
import { logger } from '../lib/logger.js';
import { adjustStock } from '../modules/inventory/inventory.service.js';
import { createOrder } from '../modules/orders/orders.service.js';
import { closePool, pool } from './pool.js';

const ADMIN_SCOPE = { all: true, ids: null };

const USERS = [
  { name: 'Ada Okafor', email: 'admin@stockpulse.dev', password: 'AdminPass1234', role: ROLES.ADMIN },
  { name: 'Bruno Mwangi', email: 'manager.nairobi@stockpulse.dev', password: 'ManagerPass1234', role: ROLES.MANAGER },
  { name: 'Chidi Balewa', email: 'manager.lagos@stockpulse.dev', password: 'ManagerPass1234', role: ROLES.MANAGER },
  { name: 'Dana Kimani', email: 'staff.nairobi@stockpulse.dev', password: 'StaffPass1234', role: ROLES.STAFF },
  { name: 'Acme Procurement', email: 'client@acme.dev', password: 'ClientPass1234', role: ROLES.CLIENT },
];

const WAREHOUSES = [
  { code: 'WH-NBO', name: 'Nairobi Central', location: 'Mombasa Road, Nairobi, KE', manager: 'manager.nairobi@stockpulse.dev' },
  { code: 'WH-LAG', name: 'Lagos Distribution', location: 'Apapa, Lagos, NG', manager: 'manager.lagos@stockpulse.dev' },
  { code: 'WH-DXB', name: 'Dubai Fulfilment', location: 'Jebel Ali Free Zone, Dubai, AE', manager: null },
];

const PRODUCTS = [
  { sku: 'SP-KEYB-01', name: 'Mechanical Keyboard K80', category: 'Peripherals', unit_price: '89.99', reorder_level: 20 },
  { sku: 'SP-MOUSE-02', name: 'Wireless Mouse M2', category: 'Peripherals', unit_price: '39.50', reorder_level: 25 },
  { sku: 'SP-MON-27-03', name: '27in 4K Monitor', category: 'Displays', unit_price: '249.00', reorder_level: 10 },
  { sku: 'SP-DOCK-04', name: 'USB-C Docking Station', category: 'Accessories', unit_price: '129.95', reorder_level: 15 },
  { sku: 'SP-HDD-2T-05', name: '2TB External Drive', category: 'Storage', unit_price: '109.00', reorder_level: 12 },
  { sku: 'SP-ROUT-06', name: 'Enterprise Router R900', category: 'Networking', unit_price: '459.00', reorder_level: 5 },
  { sku: 'SP-CABLE-07', name: 'USB-C Cable 2m', category: 'Accessories', unit_price: '12.75', reorder_level: 100 },
  { sku: 'SP-LAMP-08', name: 'LED Desk Lamp', category: 'Office', unit_price: '34.20', reorder_level: 30 },
];

/** Deliberately mixed: several lines sit below their reorder level. */
const STOCK = [
  { warehouse: 'WH-NBO', sku: 'SP-KEYB-01', quantity: 45 },
  { warehouse: 'WH-NBO', sku: 'SP-MOUSE-02', quantity: 8 },
  { warehouse: 'WH-NBO', sku: 'SP-MON-27-03', quantity: 12 },
  { warehouse: 'WH-NBO', sku: 'SP-DOCK-04', quantity: 3 },
  { warehouse: 'WH-NBO', sku: 'SP-CABLE-07', quantity: 220 },
  { warehouse: 'WH-LAG', sku: 'SP-KEYB-01', quantity: 20 },
  { warehouse: 'WH-LAG', sku: 'SP-MOUSE-02', quantity: 60 },
  { warehouse: 'WH-LAG', sku: 'SP-HDD-2T-05', quantity: 15 },
  { warehouse: 'WH-LAG', sku: 'SP-ROUT-06', quantity: 4 },
  { warehouse: 'WH-LAG', sku: 'SP-CABLE-07', quantity: 40 },
  { warehouse: 'WH-DXB', sku: 'SP-MON-27-03', quantity: 25 },
  { warehouse: 'WH-DXB', sku: 'SP-DOCK-04', quantity: 40 },
  { warehouse: 'WH-DXB', sku: 'SP-ROUT-06', quantity: 9 },
  { warehouse: 'WH-DXB', sku: 'SP-LAMP-08', quantity: 5 },
  { warehouse: 'WH-DXB', sku: 'SP-HDD-2T-05', quantity: 30 },
];

const ORDERS = [
  { items: [{ sku: 'SP-KEYB-01', quantity: 5 }, { sku: 'SP-MON-27-03', quantity: 2 }] },
  { items: [{ sku: 'SP-CABLE-07', quantity: 25 }, { sku: 'SP-DOCK-04', quantity: 1 }] },
];

async function ensureUser(client, user) {
  const existing = await client.query(
    'SELECT id, email, role FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL',
    [user.email],
  );
  if (existing.rowCount > 0) return { ...existing.rows[0], created: false };

  const passwordHash = await hashPassword(user.password);
  const { rows } = await client.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4) RETURNING id, email, role`,
    [user.name, user.email, passwordHash, user.role],
  );
  return { ...rows[0], created: true };
}

async function ensureWarehouse(client, warehouse, managerId) {
  const existing = await client.query('SELECT id, code FROM warehouses WHERE upper(code) = upper($1)', [
    warehouse.code,
  ]);
  if (existing.rowCount > 0) return { ...existing.rows[0], created: false };

  const { rows } = await client.query(
    `INSERT INTO warehouses (code, name, location, manager_id)
     VALUES ($1, $2, $3, $4) RETURNING id, code`,
    [warehouse.code, warehouse.name, warehouse.location, managerId ?? null],
  );
  return { ...rows[0], created: true };
}

async function ensureProduct(client, product) {
  const existing = await client.query('SELECT id, sku FROM products WHERE upper(sku) = upper($1)', [
    product.sku,
  ]);
  if (existing.rowCount > 0) return { ...existing.rows[0], created: false };

  const { rows } = await client.query(
    `INSERT INTO products (sku, name, category, unit_price, reorder_level)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, sku`,
    [product.sku, product.name, product.category, product.unit_price, product.reorder_level],
  );
  return { ...rows[0], created: true };
}

async function main() {
  const client = await pool.connect();
  const summary = { users: 0, warehouses: 0, products: 0, receipts: 0, orders: 0 };

  try {
    const schemaCheck = await client.query(
      `SELECT to_regclass('public.users') AS users_table`,
    );
    if (!schemaCheck.rows[0].users_table) {
      throw new Error('Schema not found. Run `npm run migrate` first.');
    }

    // --- users -------------------------------------------------------------
    const usersByEmail = new Map();
    for (const user of USERS) {
      const record = await ensureUser(client, user);
      usersByEmail.set(user.email, record);
      if (record.created) summary.users += 1;
    }

    const admin = usersByEmail.get('admin@stockpulse.dev');
    const clientUser = usersByEmail.get('client@acme.dev');

    // --- warehouses --------------------------------------------------------
    const warehousesByCode = new Map();
    for (const warehouse of WAREHOUSES) {
      const manager = warehouse.manager ? usersByEmail.get(warehouse.manager) : null;
      const record = await ensureWarehouse(client, warehouse, manager?.id);
      warehousesByCode.set(warehouse.code, record);
      if (record.created) summary.warehouses += 1;

      // Managers and the demo Staff member are granted scoped access.
      const grants = [manager?.id, usersByEmail.get('staff.nairobi@stockpulse.dev')?.id].filter(
        Boolean,
      );
      for (const userId of grants) {
        if (warehouse.code !== 'WH-NBO' && userId === usersByEmail.get('staff.nairobi@stockpulse.dev')?.id) {
          continue; // Dana only works the Nairobi warehouse.
        }
        await client.query(
          `INSERT INTO user_warehouses (user_id, warehouse_id, granted_by)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [userId, record.id, admin.id],
        );
      }
    }

    // --- products ----------------------------------------------------------
    const productsBySku = new Map();
    for (const product of PRODUCTS) {
      const record = await ensureProduct(client, product);
      productsBySku.set(product.sku, record);
      if (record.created) summary.products += 1;
    }

    // --- stock receipts (through the real service, so the ledger is written) -
    for (const entry of STOCK) {
      const warehouse = warehousesByCode.get(entry.warehouse);
      const product = productsBySku.get(entry.sku);

      const existing = await client.query(
        'SELECT quantity FROM inventory WHERE warehouse_id = $1 AND product_id = $2',
        [warehouse.id, product.id],
      );
      if (existing.rowCount > 0) continue; // idempotent: already stocked

      await adjustStock({
        actor: { id: admin.id, role: ROLES.ADMIN },
        scope: ADMIN_SCOPE,
        input: {
          warehouse_id: warehouse.id,
          product_id: product.id,
          delta: entry.quantity,
          note: 'Opening stock (seed)',
        },
      });
      summary.receipts += 1;
    }

    // --- demo orders -------------------------------------------------------
    const { rows: orderCount } = await client.query('SELECT count(*)::int AS total FROM orders');
    if (orderCount[0].total === 0) {
      for (const order of ORDERS) {
        await createOrder({
          actor: { id: clientUser.id, role: ROLES.CLIENT },
          items: order.items.map((item) => ({
            product_id: productsBySku.get(item.sku).id,
            quantity: item.quantity,
          })),
          currency: 'USD',
          limits: {
            maxLines: env.ORDER_MAX_LINES,
            maxPerLine: env.ORDER_MAX_QUANTITY_PER_LINE,
          },
        });
        summary.orders += 1;
      }
    }
  } finally {
    client.release();
  }

  logger.info('seed complete', summary);

  console.log('\nDemo accounts (development only):');
  for (const user of USERS) {
    console.log(`  ${user.role.padEnd(8)} ${user.email.padEnd(34)} ${user.password}`);
  }
  console.log('\nTry it:');
  console.log('  npm run dev');
  console.log('  curl -s localhost:4000/health | jq');
  console.log('  curl -s -c cookies.txt -X POST localhost:4000/api/auth/login \\');
  console.log('       -H "content-type: application/json" \\');
  console.log('       -d \'{"email":"admin@stockpulse.dev","password":"AdminPass1234"}\' | jq\n');
}

main()
  .catch((error) => {
    logger.error('seed failed', { error: error.message });
    process.exitCode = 1;
  })
  .finally(closePool);