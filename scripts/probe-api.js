/**
 * Temporary: dumps the exact shape of every API response the client will consume,
 * so the frontend is written against real payloads instead of assumptions.
 */
import { writeFileSync } from 'node:fs';

const { createApp } = await import('../src/app.js');

const app = createApp();
const server = await new Promise((resolve) => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function token(email, password) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!body.token) throw new Error(`login failed for ${email}: ${JSON.stringify(body)}`);
  return body.token;
}

function trim(value) {
  if (Array.isArray(value)) return value.length ? [value[0], `...(${value.length} items)`] : value;
  return value;
}

const out = [];
function record(label, response, body) {
  const payload = body?.data !== undefined ? body.data : body;
  out.push({
    label,
    status: response.status,
    data: Array.isArray(payload) ? trim(payload) : payload,
    meta: body?.meta,
    error: body?.error,
  });
}

const admin = await token('admin@stockpulse.dev', 'AdminPass1234');
const manager = await token('manager.nairobi@stockpulse.dev', 'ManagerPass1234');
const client = await token('client@acme.dev', 'ClientPass1234');

const get = (path, bearer) =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${bearer}` } });

async function probe(label, path, bearer = admin) {
  const response = await get(path, bearer);
  const body = await response.json().catch(() => ({}));
  record(label, response, body);
  return body?.data;
}

await probe('GET /api/auth/me (admin)', '/api/auth/me');
await probe('GET /api/auth/me (manager)', '/api/auth/me', manager);
await probe('GET /api/auth/me (client)', '/api/auth/me', client);
await probe('GET /api/users', '/api/users?limit=2');

const warehouses = await probe('GET /api/warehouses', '/api/warehouses?limit=3');
const warehouseId = warehouses?.[0]?.id;
await probe('GET /api/warehouses/:id', `/api/warehouses/${warehouseId}`);
await probe('GET /api/warehouses/:id/inventory', `/api/warehouses/${warehouseId}/inventory?limit=2`);
await probe('GET /api/warehouses/:id/ledger', `/api/warehouses/${warehouseId}/ledger?limit=2`);
await probe('GET /api/warehouses/:id/orders', `/api/warehouses/${warehouseId}/orders?limit=2`);

await probe('GET /api/products', '/api/products?limit=2');
await probe('GET /api/products (search+category)', '/api/products?limit=2&search=mon&category=Displays');
await probe('GET /api/catalog', '/api/catalog?limit=2');

await probe('GET /api/inventory', '/api/inventory?limit=2');
await probe('GET /api/inventory?low_stock=true', '/api/inventory?limit=2&low_stock=true');
await probe('GET /api/inventory/low-stock', '/api/inventory/low-stock?limit=2');
await probe('GET /api/inventory/ledger', '/api/inventory/ledger?limit=2');

const orders = await probe('GET /api/orders (admin)', '/api/orders?limit=2');
const orderId = orders?.[0]?.id;
await probe('GET /api/orders/:id (admin)', `/api/orders/${orderId}`);
await probe('GET /api/orders (client)', '/api/orders?limit=2', client);

await probe('GET /api/analytics/summary', '/api/analytics/summary');
await probe('GET /api/analytics/summary (manager)', '/api/analytics/summary', manager);
await probe('GET /api/analytics/sales-trend', '/api/analytics/sales-trend?days=14');
await probe('GET /api/analytics/top-products', '/api/analytics/top-products?limit=3');
await probe('GET /api/analytics/by-warehouse', '/api/analytics/by-warehouse');
await probe('GET /api/analytics/summary (client -> 403)', '/api/analytics/summary', client);
await probe('GET /api/analytics/bad-params', '/api/analytics/sales-trend?days=9999');
await probe('GET /api/orders/999999', '/api/orders/999999');

writeFileSync('api-shapes.json', JSON.stringify(out, null, 2));
console.log(`wrote api-shapes.json (${out.length} endpoints)`);

server.close();
process.exit(0);