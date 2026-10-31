/**
 * Live RBAC / warehouse-scope verification against the Docker database.
 * Run with the API listening on BASE (default http://127.0.0.1:4100).
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:4100';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(`${name} ${detail}`);
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function login(email, password) {
  const { status, json } = await api('POST', '/api/auth/login', { body: { email, password } });
  if (status !== 200) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

const ACCOUNTS = {
  admin: ['admin@stockpulse.dev', 'AdminPass1234'],
  nairobi: ['manager.nairobi@stockpulse.dev', 'ManagerPass1234'],
  lagos: ['manager.lagos@stockpulse.dev', 'ManagerPass1234'],
  staff: ['staff.nairobi@stockpulse.dev', 'StaffPass1234'],
};

const tokens = {};
for (const [key, [email, password]] of Object.entries(ACCOUNTS)) {
  tokens[key] = await login(email, password);
}

const warehouseIds = (json) => (json?.data ?? []).map((w) => w.id).sort((a, b) => a - b);

console.log('\n=== 1. Warehouse scope from /api/auth/me ===');
const scopes = {};
const profileIds = {};
for (const [key, token] of Object.entries(tokens)) {
  const { json } = await api('GET', '/api/auth/me', { token });
  scopes[key] = json.data.scope;
  profileIds[key] = json.data.id;
  console.log(`  ${key.padEnd(8)} role=${(json.data.role ?? '').padEnd(8)} scope=${JSON.stringify(json.data.scope)}`);
}
check('admin scope is global (all=true)', scopes.admin.all === true);
check('nairobi manager restricted to [1]', !scopes.nairobi.all && JSON.stringify(scopes.nairobi.ids) === '[1]', JSON.stringify(scopes.nairobi));
check('lagos manager restricted to [2]', !scopes.lagos.all && JSON.stringify(scopes.lagos.ids) === '[2]', JSON.stringify(scopes.lagos));
check('staff restricted to [1]', !scopes.staff.all && JSON.stringify(scopes.staff.ids) === '[1]', JSON.stringify(scopes.staff));

console.log('\n=== 2. GET /api/warehouses (drives the dropdown) ===');
const listing = {};
for (const [key, token] of Object.entries(tokens)) {
  const { json } = await api('GET', '/api/warehouses?limit=100', { token });
  listing[key] = warehouseIds(json);
  console.log(`  ${key.padEnd(8)} -> ${JSON.stringify(listing[key])}`);
}
check('admin sees all 3 warehouses', JSON.stringify(listing.admin) === '[1,2,3]', JSON.stringify(listing.admin));
check('nairobi manager sees only [1]', JSON.stringify(listing.nairobi) === '[1]', JSON.stringify(listing.nairobi));
check('lagos manager sees only [2]', JSON.stringify(listing.lagos) === '[2]', JSON.stringify(listing.lagos));
check('staff sees only [1]', JSON.stringify(listing.staff) === '[1]', JSON.stringify(listing.staff));

console.log('\n=== 3. IDOR: manager reaching warehouse 2 by URL / query / body ===');
const idorCases = [
  ['GET /api/warehouses/2', 'GET', '/api/warehouses/2', undefined],
  ['GET /api/warehouses/2/inventory', 'GET', '/api/warehouses/2/inventory', undefined],
  ['GET /api/warehouses/2/ledger', 'GET', '/api/warehouses/2/ledger', undefined],
  ['GET /api/warehouses/2/orders', 'GET', '/api/warehouses/2/orders', undefined],
  ['GET /api/inventory?warehouse_id=2', 'GET', '/api/inventory?warehouse_id=2', undefined],
  ['GET /api/inventory/ledger?warehouse_id=2', 'GET', '/api/inventory/ledger?warehouse_id=2', undefined],
  ['GET /api/orders?warehouse_id=2', 'GET', '/api/orders?warehouse_id=2', undefined],
  ['GET /api/warehouses/3', 'GET', '/api/warehouses/3', undefined],
  ['GET /api/warehouses/1 (own, must be 200)', 'GET', '/api/warehouses/1', undefined],
];
for (const [name, method, path] of idorCases) {
  const { status } = await api(method, path, { token: tokens.nairobi });
  const expectOwn = name.includes('must be 200');
  check(name, expectOwn ? status === 200 : status === 403, `got ${status}`);
}

console.log('\n=== 4. Order-creation scope enforcement (body.warehouse_id) ===');
const products = await api('GET', '/api/products?limit=100', { token: tokens.admin });
const withStock = [];
for (const product of products.json.data ?? []) {
  const inv = await api('GET', `/api/inventory?product_id=${product.id}&limit=100`, { token: tokens.admin });
  for (const row of inv.json.data ?? []) {
    if (row.quantity > 0) withStock.push({ product_id: product.id, warehouse_id: row.warehouse.id, quantity: row.quantity, sku: product.sku });
  }
}
console.log(`  stock rows available: ${withStock.slice(0, 6).map((r) => `${r.sku}@wh${r.warehouse_id}=${r.quantity}`).join(', ')}`);

const stockAt = (wh) => withStock.find((r) => r.warehouse_id === wh);
const atWh1 = stockAt(1);
const atWh2 = stockAt(2);
const atWh3 = stockAt(3);

if (atWh2) {
  const { status, json } = await api('POST', '/api/orders', {
    token: tokens.nairobi,
    body: { items: [{ product_id: atWh2.product_id, quantity: 1, warehouse_id: 2 }] },
  });
  check('manager cannot create an order in warehouse 2', status === 403, `got ${status} ${JSON.stringify(json?.error ?? {})}`);
} else {
  console.log('  SKIP  no stock at warehouse 2 to attempt cross-warehouse order');
}

console.log('\n=== 5. Manager creates an order in their own warehouse ===');
if (atWh1) {
  const { status, json } = await api('POST', '/api/orders', {
    token: tokens.nairobi,
    body: { items: [{ product_id: atWh1.product_id, quantity: 1, warehouse_id: 1 }] },
  });
  check('manager order in own warehouse -> 201', status === 201, `got ${status} ${JSON.stringify(json?.error ?? {})}`);
  if (status === 201) {
    const orderId = json.data.id;
    const detail = await api('GET', `/api/orders/${orderId}`, { token: tokens.nairobi });
    const whs = (detail.json.data?.items ?? []).map((i) => i.warehouse?.id);
    check('created order lines all belong to warehouse 1', whs.length > 0 && whs.every((w) => w === 1), JSON.stringify(whs));
    console.log(`  created order ${json.data.order_number} total=${json.data.total_amount}`);
  }
} else {
  console.log('  SKIP  no stock at warehouse 1');
}

console.log('\n=== 6. Manager auto-allocation stays inside scope (no warehouse_id sent) ===');
if (atWh2) {
  const { status, json } = await api('POST', '/api/orders', {
    token: tokens.nairobi,
    body: { items: [{ product_id: atWh2.product_id, quantity: 1 }] },
  });
  if (status === 201) {
    const detail = await api('GET', `/api/orders/${json.data.id}`, { token: tokens.nairobi });
    const whs = (detail.json.data?.items ?? []).map((i) => i.warehouse?.id);
    check('auto-allocated lines never leave manager scope', whs.every((w) => w === 1), JSON.stringify(whs));
  } else {
    check('auto-allocation of out-of-scope stock either 201@wh1 or 409/422 (never wh2)', [409, 422, 201].includes(status), `got ${status} ${JSON.stringify(json?.error ?? {})}`);
  }
} else {
  console.log('  SKIP  product without warehouse 1 stock unavailable');
}

console.log('\n=== 7. Admin functionality unchanged ===');
{
  const { status, json } = await api('GET', '/api/warehouses/3', { token: tokens.admin });
  check('admin can read warehouse 3', status === 200, `got ${status}`);
  const { status: s2, json: j2 } = await api('GET', '/api/orders?limit=100', { token: tokens.admin });
  check('admin order list 200', s2 === 200, `got ${s2}`);
  console.log(`  admin sees ${j2.meta?.total} orders`);
  if (atWh3) {
    const { status: s3, json: j3 } = await api('POST', '/api/orders', {
      token: tokens.admin,
      body: { items: [{ product_id: atWh3.product_id, quantity: 1, warehouse_id: 3 }] },
    });
    check('admin can create an order at warehouse 3', s3 === 201, `got ${s3} ${JSON.stringify(j3?.error ?? {})}`);
  } else {
    console.log('  SKIP  no stock at warehouse 3 for admin order test');
  }
  const { status: s4 } = await api('GET', '/api/admin/overview', { token: tokens.admin });
  check('admin overview 200', s4 === 200, `got ${s4}`);
  const { status: s5 } = await api('GET', '/api/admin/overview', { token: tokens.nairobi });
  check('manager overview 403', s5 === 403, `got ${s5}`);
}

console.log('\n=== 8. Manager order list only shows in-scope orders ===');
{
  const { status, json } = await api('GET', '/api/orders?limit=100', { token: tokens.nairobi });
  check('manager order list 200', status === 200, `got ${status}`);
  let outOfScope = 0;
  for (const row of json.data ?? []) {
    const detail = await api('GET', `/api/orders/${row.id}`, { token: tokens.nairobi });
    for (const item of detail.json.data?.items ?? []) {
      if (item.warehouse?.id !== 1) outOfScope += 1;
    }
  }
  check('no out-of-scope order lines visible to manager', outOfScope === 0, `${outOfScope} lines leaked`);
  console.log(`  manager sees ${json.data.length} orders`);
}

console.log('\n=== 9. Other warehouse-dependent surfaces ===');
{
  // Analytics must aggregate only over the caller's warehouses.
  const { status, json } = await api('GET', '/api/analytics/by-warehouse', { token: tokens.nairobi });
  // Response is a flat array whose `id` is the warehouse id.
  const ids = (json?.data ?? []).map((row) => row.id);
  check('analytics by-warehouse 200 for manager', status === 200, `got ${status}`);
  check('analytics by-warehouse only returns in-scope warehouses', ids.length > 0 && ids.every((id) => id === 1), JSON.stringify(ids));

  const summary = await api('GET', '/api/analytics/summary', { token: tokens.nairobi });
  check('analytics summary 200 for manager', summary.status === 200, `got ${summary.status}`);

  // Product listing aggregates stock; a manager must not see warehouse 2 units.
  const prod = await api('GET', '/api/products?limit=100', { token: tokens.nairobi });
  check('products list 200 for manager', prod.status === 200, `got ${prod.status}`);
  const adminProd = await api('GET', '/api/products?limit=100', { token: tokens.admin });
  const adminById = new Map((adminProd.json.data ?? []).map((p) => [p.id, Number(p.total_quantity ?? 0)]));
  const leaks = (prod.json.data ?? []).filter((p) => Number(p.total_quantity ?? 0) > (adminById.get(p.id) ?? 0));
  check('product totals never exceed the admin total', leaks.length === 0, JSON.stringify(leaks.map((p) => p.sku)));

  // Bulk product import into a foreign warehouse must be refused. The file check
  // runs first, so a real CSV is required to reach the warehouse-scope guard.
  const csv = 'sku,product_name,unit_price,quantity\nQA-SCOPE-1,Scope probe,1.00,1\n';
  const form = new FormData();
  form.append('warehouse_id', '2');
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'scope-probe.csv');
  const bulk = await fetch(`${BASE}/api/products/bulk-import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.nairobi}` },
    body: form,
  });
  check('manager cannot bulk-import products into warehouse 2', bulk.status === 403, `got ${bulk.status}`);

  // The same import into their own warehouse must not be blocked by the guard.
  const ownForm = new FormData();
  ownForm.append('warehouse_id', '1');
  ownForm.append('file', new Blob([csv], { type: 'text/csv' }), 'scope-probe.csv');
  const ownBulk = await fetch(`${BASE}/api/products/bulk-import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.nairobi}` },
    body: ownForm,
  });
  check('manager can bulk-import into their own warehouse (guard is scoped, not blanket)',
    [200, 201, 409].includes(ownBulk.status), `got ${ownBulk.status}`);
}

console.log('\n=== 10. LAST_ADMIN guard (classification of an unrelated failing test) ===');
{
  const { status, json } = await api('PATCH', `/api/users/${profileIds.admin}`, {
    token: tokens.admin,
    body: { role: 'Staff' },
  });
  check('sole admin cannot demote itself -> 409 LAST_ADMIN', status === 409, `got ${status} ${JSON.stringify(json?.error?.code ?? json?.error ?? {})}`);
}

console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
if (failures.length) console.log(`Failures:\n - ${failures.join('\n - ')}`);
process.exit(fail === 0 ? 0 : 1);
