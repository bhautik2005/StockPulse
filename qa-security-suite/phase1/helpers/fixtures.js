/**
 * Phase 1 :: Fixtures.
 *
 * Everything is created through the public HTTP API (except the bootstrap
 * Admin), so a fixture failure is itself a signal that a real code path broke.
 * Where a fixture bypasses the API -- `insertProduct`, `insertWarehouse` -- it is
 * marked as such and used only where the test is about the SQL layer rather than
 * the endpoint.
 */
import { app, bootstrapAdmin, query, scalar } from '../setup/db.js';
import { createClient } from './client.js';

const PASSWORD = 'Password1234';

let sequence = 0;

/**
 * A short, collision-resistant, LOWERCASE key.
 *
 * Deliberately short AND lowercase, for two separate reasons:
 *
 *   Length -- `warehouses.code` is varchar(20), so a key built from a
 *   millisecond timestamp (13 chars) plus a counter overruns the column and the
 *   insert fails with 22001 (string_data_right_truncation). That surfaces as
 *   "insertWarehouse returned undefined", which looks nothing like a length
 *   problem. A base-36 millisecond timestamp (8 chars) plus a counter fits
 *   comfortably inside every identifier limit.
 *
 *   Case -- several tests interpolate this into an email address, and the
 *   database stores emails via `lower(email)`. An uppercase key makes the stored
 *   address differ from the one the test sent, which reads as an unrelated
 *   "expected X, received x" failure.
 */
export function uniqueKey(prefix = 'x') {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}

export { PASSWORD };

/**
 * Bootstraps an Admin and returns a signed-in client.
 *
 * The first Admin cannot be created over HTTP (public registration always
 * produces a Client), so it is inserted directly -- mirroring src/db/seed.js.
 */
export async function adminSession({ email = `root-${uniqueKey()}@stockpulse.test` } = {}) {
  const admin = await bootstrapAdmin({ email });
  const api = createClient(app);
  const response = await api.login(admin.email, admin.password);

  if (response.status !== 200) {
    throw new Error(`admin login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { ...admin, api };
}

export async function createWarehouse(api, overrides = {}) {
  const key = uniqueKey('wh');
  const response = await api.post('/api/warehouses', {
    code: (overrides.code ?? key).toUpperCase().replace(/[^A-Z0-9-]/g, ''),
    name: overrides.name ?? `Warehouse ${key}`,
    location: overrides.location ?? 'Test Location',
    ...(overrides.manager_id ? { manager_id: overrides.manager_id } : {}),
  });

  if (response.status !== 201) {
    throw new Error(`createWarehouse failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.data;
}

export async function createProduct(api, overrides = {}) {
  const key = uniqueKey('sku');
  const response = await api.post('/api/products', {
    sku: overrides.sku ?? key.toUpperCase(),
    name: overrides.name ?? `Product ${key}`,
    category: overrides.category ?? 'Test',
    unit_price: overrides.unit_price ?? '19.99',
    reorder_level: overrides.reorder_level ?? 10,
  });

  if (response.status !== 201) {
    throw new Error(`createProduct failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.data;
}

export async function createUser(api, overrides = {}) {
  const key = uniqueKey('user');
  const response = await api.post('/api/users', {
    name: overrides.name ?? `User ${key}`,
    email: overrides.email ?? `${key}@stockpulse.test`,
    password: overrides.password ?? PASSWORD,
    role: overrides.role ?? 'Staff',
    ...(overrides.warehouse_ids ? { warehouse_ids: overrides.warehouse_ids } : {}),
  });

  if (response.status !== 201) {
    throw new Error(`createUser failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { ...response.body.data, password: overrides.password ?? PASSWORD };
}

/** Signs in an internal user created by `createUser`. */
export async function sessionFor(email, password = PASSWORD) {
  const api = createClient(app);
  const response = await api.login(email, password);
  if (response.status !== 200) {
    throw new Error(`login failed for ${email}: ${response.status}`);
  }
  return api;
}

export async function receiveStock(api, { warehouseId, productId, quantity, note = 'fixture receipt' }) {
  const response = await api.post('/api/inventory/adjust', {
    warehouse_id: warehouseId,
    product_id: productId,
    delta: quantity,
    note,
  });

  if (response.status !== 201) {
    throw new Error(`receiveStock failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.data;
}

/** Registers a Client through the public endpoint and signs them in. */
export async function createClientAccount(overrides = {}) {
  const key = uniqueKey('client');
  const email = overrides.email ?? `${key}@client.test`;
  const anonymous = createClient(app);

  const registration = await anonymous.post('/api/auth/register', {
    name: overrides.name ?? `Client ${key}`,
    email,
    password: overrides.password ?? PASSWORD,
  });

  if (registration.status !== 201) {
    throw new Error(`register failed: ${registration.status} ${JSON.stringify(registration.body)}`);
  }

  const api = createClient(app);
  const login = await api.login(email, overrides.password ?? PASSWORD);
  if (login.status !== 200) {
    throw new Error(`client login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }

  return { ...registration.body.data, password: overrides.password ?? PASSWORD, api };
}

/**
 * A complete, small world: one Admin, one warehouse with stock, one product and
 * one signed-in Client. Used by the transaction tests, which need the domain
 * relationships but not the full multi-warehouse fixture in tests/helpers.
 */
export async function createSimpleWorld({ stock = 100 } = {}) {
  const admin = await adminSession();
  const warehouse = await createWarehouse(admin.api);
  const product = await createProduct(admin.api, { unit_price: '25.50', reorder_level: 5 });

  await receiveStock(admin.api, { warehouseId: warehouse.id, productId: product.id, quantity: stock });

  const client = await createClientAccount();

  return {
    admin,
    warehouse,
    product,
    client,
    onHand: () => onHand(warehouse.id, product.id),
  };
}

/** Current on-hand quantity, read straight from SQL (never from the response). */
export async function onHand(warehouseId, productId) {
  const value = await scalar(
    'SELECT quantity FROM inventory WHERE warehouse_id = $1 AND product_id = $2',
    [warehouseId, productId],
  );
  return value === undefined ? undefined : Number(value);
}

/** Ledger row count for an order, used to prove movements are explained. */
export async function ledgerCountForOrder(orderId) {
  const value = await scalar(
    `SELECT count(*)::int FROM inventory_transactions WHERE ref_type = 'order' AND ref_id = $1`,
    [orderId],
  );
  return Number(value ?? 0);
}

/**
 * Inserts a product directly, bypassing the API.
 *
 * For Phase 2 only: those tests attack the database, and routing them through
 * HTTP would make the schema the second thing under test instead of the first.
 */
export async function insertProduct({ sku = uniqueKey('SKU').toUpperCase(), name = `Direct Product ${uniqueKey()}`, unitPrice = '10.00', reorderLevel = 0 } = {}) {
  const { rows } = await query(
    `INSERT INTO products (sku, name, category, unit_price, reorder_level)
     VALUES ($1, $2, 'Direct', $3, $4)
     RETURNING id, sku, unit_price`,
    [sku, name, unitPrice, reorderLevel],
  );
  return rows[0];
}

/**
 * Inserts a warehouse directly, bypassing the API. Phase 2 only.
 *
 * The name is unique by default: `warehouses_name_uniq` is a functional unique
 * index on lower(name), so two "Direct Warehouse" rows collide and turn an
 * unrelated test into a confusing 23505.
 */
export async function insertWarehouse({ code = uniqueKey('WH').toUpperCase(), name = `Direct Warehouse ${uniqueKey()}`, location = 'Nowhere' } = {}) {
  const { rows } = await query(
    `INSERT INTO warehouses (code, name, location) VALUES ($1, $2, $3) RETURNING id, code`,
    [code, name, location],
  );
  return rows[0];
}

/** Inserts inventory directly, bypassing the API. Phase 2 only. */
export async function insertInventory(warehouseId, productId, quantity) {
  const { rows } = await query(
    `INSERT INTO inventory (warehouse_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (warehouse_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity
     RETURNING id, quantity`,
    [warehouseId, productId, quantity],
  );
  return rows[0];
}
