/**
 * P0 :: RBAC and data scoping.
 *
 * Two questions must both be answered before warehouse data is returned:
 * is this *role* allowed to do this kind of thing, and is this *record* inside
 * the caller's scope. These tests pin down the second one -- the IDOR boundary
 * that a role check alone does not close.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { resetDatabase, scalar, startServer } from './helpers/harness.js';
import { createApiClient, isError } from './helpers/api.js';
import { createClient, createUser, createWorld, receiveStock } from './helpers/fixtures.js';

describe('P0 :: RBAC and warehouse scoping', () => {
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

  it('denies a Manager access to a warehouse they do not own (IDOR)', async () => {
    const response = await world.managers.nairobi.api.get(
      `/api/warehouses/${world.warehouses.lagos.id}/inventory`,
    );

    assert.equal(response.status, 403, 'a role check alone would have allowed this');
    assert.equal(response.body.error.code, 'WAREHOUSE_FORBIDDEN');

    const own = await world.managers.nairobi.api.get(
      `/api/warehouses/${world.warehouses.nairobi.id}/inventory`,
    );
    assert.equal(own.status, 200, 'their own warehouse must still work');
  });

  it('returns only in-scope rows from a scoped inventory listing', async () => {
    const response = await world.managers.lagos.api.get('/api/inventory', { query: { limit: 100 } });

    assert.equal(response.status, 200);
    assert.ok(response.body.data.length > 0, 'the Lagos manager does have stock to see');
    assert.ok(
      response.body.data.every((row) => row.warehouse.id === world.warehouses.lagos.id),
      'no row from another warehouse may appear',
    );
  });

  it('lets an Admin see every warehouse', async () => {
    const response = await world.admin.api.get('/api/warehouses', { query: { limit: 100 } });
    const ids = response.body.data.map((row) => row.id);

    assert.ok(ids.includes(world.warehouses.nairobi.id));
    assert.ok(ids.includes(world.warehouses.lagos.id));
    assert.ok(ids.includes(world.warehouses.dubai.id));
  });

  it('refuses a Staff member writing stock into a warehouse they are not assigned to', async () => {
    const product = world.products.keyboard;

    const response = await world.staff.nairobi.api.post('/api/inventory/adjust', {
      warehouse_id: world.warehouses.lagos.id,
      product_id: product.id,
      delta: 5,
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'WAREHOUSE_FORBIDDEN');
  });

  it('keeps Clients out of internal endpoints entirely', async () => {
    const inventory = await world.clients.acme.api.get('/api/inventory');
    assert.equal(inventory.status, 403);
    assert.equal(inventory.body.error.code, 'INSUFFICIENT_ROLE');

    const analytics = await world.clients.acme.api.get('/api/analytics/summary');
    assert.equal(analytics.status, 403);

    const users = await world.clients.acme.api.get('/api/users');
    assert.equal(users.status, 403);

    const adjust = await world.clients.acme.api.post('/api/inventory/adjust', {
      warehouse_id: world.warehouses.nairobi.id,
      product_id: world.products.keyboard.id,
      delta: 1,
    });
    assert.equal(adjust.status, 403);
  });

  it('restricts warehouse creation to Admins', async () => {
    const response = await world.managers.nairobi.api.post('/api/warehouses', {
      code: 'SHOULD-FAIL',
      name: 'Unauthorised',
      location: 'Nowhere',
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'INSUFFICIENT_ROLE');
  });

  it('shows a Manager only orders with lines they are responsible for', async () => {
    const nairobiOrder = await world.clients.acme.api.post('/api/orders', {
      items: [
        {
          product_id: world.products.keyboard.id,
          quantity: 1,
          warehouse_id: world.warehouses.nairobi.id,
        },
      ],
    });
    const lagosOrder = await world.clients.acme.api.post('/api/orders', {
      items: [
        { product_id: world.products.keyboard.id, quantity: 1, warehouse_id: world.warehouses.lagos.id },
      ],
    });

    assert.equal(nairobiOrder.status, 201);
    assert.equal(lagosOrder.status, 201);

    const nairobiList = await world.managers.nairobi.api.get('/api/orders', {
      query: { limit: 100 },
    });
    const visibleIds = nairobiList.body.data.map((row) => row.id);

    assert.ok(visibleIds.includes(nairobiOrder.body.data.id));
    assert.ok(
      !visibleIds.includes(lagosOrder.body.data.id),
      "another warehouse's order must not be listed",
    );

    // And a direct fetch must not leak it either.
    const direct = await world.managers.nairobi.api.get(`/api/orders/${lagosOrder.body.data.id}`);
    assert.equal(direct.status, 404);
  });

  it('scopes analytics to the caller’s warehouses', async () => {
    const nairobi = await world.managers.nairobi.api.get('/api/analytics/summary');
    const admin = await world.admin.api.get('/api/analytics/summary');

    assert.equal(nairobi.status, 200);
    assert.equal(nairobi.body.data.scope, 'assigned_warehouses');
    assert.equal(admin.body.data.scope, 'all_warehouses');

    const breakdown = await world.managers.nairobi.api.get('/api/analytics/by-warehouse');
    assert.deepEqual(
      breakdown.body.data.map((row) => row.id),
      [world.warehouses.nairobi.id],
      'the breakdown must contain only their warehouse',
    );
  });

  it('never lets public registration create a privileged account', async () => {
    const anonymous = createApiClient(server.baseUrl);
    const response = await anonymous.post('/api/auth/register', {
      name: 'Privilege Escalation Attempt',
      email: `escalate-${Date.now()}@client.test`,
      password: 'Password1234',
      role: 'Admin', // must be stripped, not honoured
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.role, 'Client', 'role from the request body must be ignored');
  });

  it('revokes existing sessions when a role changes', async () => {
    const user = await createUser(world.admin.api, { role: 'Staff' });
    const api = createApiClient(server.baseUrl);
    const login = await api.login(user.email, user.password);
    assert.equal(login.status, 200);

    // The session works to begin with.
    assert.equal((await api.get('/api/catalog')).status, 200);

    const promoted = await world.admin.api.patch(`/api/users/${user.id}`, { role: 'Manager' });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.data.sessions_revoked, true);

    const afterPromotion = await api.get('/api/auth/me');
    assert.equal(afterPromotion.status, 401, 'the stale token must stop working immediately');
    assert.equal(afterPromotion.body.error.code, 'TOKEN_REVOKED');
  });

  it('blocks a disabled account even with a valid token', async () => {
    const user = await createUser(world.admin.api, { role: 'Staff' });
    const api = createApiClient(server.baseUrl);
    await api.login(user.email, user.password);

    await world.admin.api.patch(`/api/users/${user.id}`, { is_active: false });

    const response = await api.get('/api/auth/me');
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'ACCOUNT_DISABLED');
  });

  it('refuses to remove the last administrator', async () => {
    const demote = await world.admin.api.patch(`/api/users/${world.admin.id}`, { role: 'Staff' });
    assert.equal(demote.status, 409);
    assert.equal(demote.body.error.code, 'LAST_ADMIN');

    const deactivate = await world.admin.api.patch(`/api/users/${world.admin.id}`, {
      is_active: false,
    });
    assert.equal(deactivate.status, 409);
    assert.equal(deactivate.body.error.code, 'LAST_ADMIN');
  });

  it('requires a CSRF token on cookie-authenticated writes', async () => {
    const api = createApiClient(server.baseUrl);
    await api.login(world.clients.acme.email, world.clients.acme.password);
    assert.ok(api.cookies.has('sp_csrf'), 'a CSRF cookie should be issued at sign-in');

    const withoutToken = await api.post(
      '/api/orders',
      {
        items: [
          {
            product_id: world.products.keyboard.id,
            quantity: 1,
            warehouse_id: world.warehouses.nairobi.id,
          },
        ],
      },
      { omitCsrf: true },
    );

    assert.equal(withoutToken.status, 403);
    assert.equal(withoutToken.body.error.code, 'CSRF_FAILED');

    // The same request with the token succeeds.
    const withToken = await api.post('/api/orders', {
      items: [
        {
          product_id: world.products.keyboard.id,
          quantity: 1,
          warehouse_id: world.warehouses.nairobi.id,
        },
      ],
    });
    assert.equal(withToken.status, 201);
  });

  it('accepts a Bearer token without CSRF, and rejects a forged one', async () => {
    // Obtain a token, then discard the cookies so only the header path remains.
    const tokenClient = createApiClient(server.baseUrl);
    const login = await tokenClient.login(world.clients.globex.email, world.clients.globex.password);
    const token = login.body.token;

    const headerOnly = createApiClient(server.baseUrl);
    headerOnly.useBearer(token);

    const response = await headerOnly.post(
      '/api/orders',
      {
        items: [
          {
            product_id: world.products.keyboard.id,
            quantity: 1,
            warehouse_id: world.warehouses.nairobi.id,
          },
        ],
      },
      { omitCsrf: true },
    );
    assert.equal(response.status, 201, 'a header token is not attached ambiently, so no CSRF');

    const forged = createApiClient(server.baseUrl);
    forged.useBearer(`${token.split('.').slice(0, 2).join('.')}.forgedsignature`);
    const rejected = await forged.get('/api/auth/me');
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.error.code, 'TOKEN_INVALID');
  });

  it('rejects unauthenticated access to protected routes', async () => {
    const anonymous = createApiClient(server.baseUrl);

    assert.equal((await anonymous.get('/api/orders')).status, 401);
    assert.equal((await anonymous.get('/api/inventory')).status, 401);
    assert.equal((await anonymous.get('/api/analytics/summary')).status, 401);
    assert.ok(isError(await anonymous.post('/api/orders', { items: [] }), 'UNAUTHENTICATED'));
  });

  it('does not leak which emails are registered', async () => {
    const anonymous = createApiClient(server.baseUrl);

    const unknownEmail = await anonymous.post('/api/auth/login', {
      email: 'nobody@nowhere.test',
      password: 'Password1234',
    });
    const wrongPassword = await anonymous.post('/api/auth/login', {
      email: world.clients.acme.email,
      password: 'DefinitelyWrong1234',
    });

    assert.equal(unknownEmail.status, 401);
    assert.equal(wrongPassword.status, 401);
    assert.equal(
      unknownEmail.body.error.code,
      wrongPassword.body.error.code,
      'both failure modes must be indistinguishable',
    );
    assert.equal(unknownEmail.body.error.message, wrongPassword.body.error.message);
  });

  it('records an audit trail of who changed what', async () => {
    const warehouseId = world.warehouses.nairobi.id;
    const product = world.products.monitor;

    await world.managers.nairobi.api.post('/api/inventory/adjust', {
      warehouse_id: warehouseId,
      product_id: product.id,
      delta: 7,
      note: 'Cycle count correction',
    });

    const createdBy = await scalar(
      `SELECT u.role
         FROM inventory_transactions t
         JOIN users u ON u.id = t.created_by
        WHERE t.warehouse_id = $1 AND t.product_id = $2
        ORDER BY t.id DESC
        LIMIT 1`,
      [warehouseId, product.id],
    );

    assert.equal(createdBy, 'Manager', 'the ledger must attribute the change to a real actor');
  });
});