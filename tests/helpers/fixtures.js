/**
 * Fixture world.
 *
 * Everything is created through the public API (except the bootstrap admin),
 * so a fixture failure is itself a signal that the real code paths are broken.
 */
import { createApiClient } from './api.js';
import { bootstrapAdmin } from './harness.js';

let sequence = 0;
export function uniqueKey(prefix = 'x') {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}

const PASSWORD = 'Password1234';

export async function createWarehouse(api, overrides = {}) {
  const key = uniqueKey('wh');
  const response = await api.post('/api/warehouses', {
    code: overrides.code ?? key.toUpperCase().replace(/[^A-Z0-9-]/g, ''),
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

export async function receiveStock(api, { warehouseId, productId, quantity }) {
  const response = await api.post('/api/inventory/adjust', {
    warehouse_id: warehouseId,
    product_id: productId,
    delta: quantity,
    note: 'fixture receipt',
  });
  if (response.status !== 201) {
    throw new Error(`receiveStock failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.data;
}

/** Registers a Client through the public endpoint and signs them in. */
export async function createClient(baseUrl, overrides = {}) {
  const key = uniqueKey('client');
  const email = overrides.email ?? `${key}@client.test`;
  const anonymous = createApiClient(baseUrl);

  const registration = await anonymous.post('/api/auth/register', {
    name: overrides.name ?? `Client ${key}`,
    email,
    password: PASSWORD,
  });
  if (registration.status !== 201) {
    throw new Error(`register failed: ${registration.status} ${JSON.stringify(registration.body)}`);
  }

  const api = createApiClient(baseUrl);
  const login = await api.login(email, PASSWORD);
  if (login.status !== 200) {
    throw new Error(`client login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }

  return { ...registration.body.data, password: PASSWORD, api };
}

/**
 * Builds two warehouses with separate managers, a Staff member scoped to one of
 * them, two Clients, four products and mixed stock levels (including lines that
 * sit below their reorder level).
 */
export async function createWorld(baseUrl) {
  const admin = await bootstrapAdmin({ email: `root-${uniqueKey()}@stockpulse.test` });
  const adminApi = createApiClient(baseUrl);
  await adminApi.login(admin.email, admin.password);

  // --- warehouses --------------------------------------------------------
  const nairobi = await createWarehouse(adminApi, {
    code: `NBO-${uniqueKey()}`.toUpperCase(),
    name: 'Nairobi Central',
    location: 'Mombasa Road, Nairobi',
  });
  const lagos = await createWarehouse(adminApi, {
    code: `LAG-${uniqueKey()}`.toUpperCase(),
    name: 'Lagos Distribution',
    location: 'Apapa, Lagos',
  });
  const dubai = await createWarehouse(adminApi, {
    code: `DXB-${uniqueKey()}`.toUpperCase(),
    name: 'Dubai Fulfilment',
    location: 'Jebel Ali, Dubai',
  });

  // --- internal users ----------------------------------------------------
  const managerNairobi = await createUser(adminApi, {
    role: 'Manager',
    name: 'Nairobi Manager',
    warehouse_ids: [nairobi.id],
  });
  const managerLagos = await createUser(adminApi, {
    role: 'Manager',
    name: 'Lagos Manager',
    warehouse_ids: [lagos.id],
  });
  const staffNairobi = await createUser(adminApi, {
    role: 'Staff',
    name: 'Nairobi Staff',
    warehouse_ids: [nairobi.id],
  });

  const managerNairobiApi = createApiClient(baseUrl);
  await managerNairobiApi.login(managerNairobi.email, managerNairobi.password);
  const managerLagosApi = createApiClient(baseUrl);
  await managerLagosApi.login(managerLagos.email, managerLagos.password);
  const staffNairobiApi = createApiClient(baseUrl);
  await staffNairobiApi.login(staffNairobi.email, staffNairobi.password);

  // Managers own their warehouse (accountability) in addition to the grant.
  await adminApi.patch(`/api/warehouses/${nairobi.id}`, { manager_id: managerNairobi.id });
  await adminApi.patch(`/api/warehouses/${lagos.id}`, { manager_id: managerLagos.id });

  // --- products ----------------------------------------------------------
  const keyboard = await createProduct(adminApi, { sku: `KEYB-${uniqueKey()}`, name: 'Mechanical Keyboard', unit_price: '89.99', reorder_level: 20 });
  const monitor = await createProduct(adminApi, { sku: `MON-${uniqueKey()}`, name: '27in Monitor', unit_price: '249.00', reorder_level: 10 });
  const router = await createProduct(adminApi, { sku: `ROUT-${uniqueKey()}`, name: 'Enterprise Router', unit_price: '459.00', reorder_level: 5 });
  const cable = await createProduct(adminApi, { sku: `CABLE-${uniqueKey()}`, name: 'USB-C Cable', unit_price: '12.75', reorder_level: 100 });

  // --- stock (deliberately includes below-threshold lines) ---------------
  await receiveStock(adminApi, { warehouseId: nairobi.id, productId: keyboard.id, quantity: 50 });
  await receiveStock(adminApi, { warehouseId: nairobi.id, productId: monitor.id, quantity: 5 });
  await receiveStock(adminApi, { warehouseId: lagos.id, productId: keyboard.id, quantity: 30 });
  await receiveStock(adminApi, { warehouseId: lagos.id, productId: router.id, quantity: 4 });
  await receiveStock(adminApi, { warehouseId: dubai.id, productId: monitor.id, quantity: 20 });
  await receiveStock(adminApi, { warehouseId: dubai.id, productId: cable.id, quantity: 200 });

  // --- clients -----------------------------------------------------------
  const acme = await createClient(baseUrl, { name: 'Acme Procurement' });
  const globex = await createClient(baseUrl, { name: 'Globex Purchasing' });

  return {
    admin: { ...admin, api: adminApi },
    warehouses: { nairobi, lagos, dubai },
    products: { keyboard, monitor, router, cable },
    managers: {
      nairobi: { ...managerNairobi, api: managerNairobiApi },
      lagos: { ...managerLagos, api: managerLagosApi },
    },
    staff: { nairobi: { ...staffNairobi, api: staffNairobiApi } },
    clients: { acme, globex },
  };
}