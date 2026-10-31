/**
 * Phase 4 :: Role-Based Access Control.
 *
 * The question this file answers is not "can an Admin reach /api/admin?" -- that
 * is the easy half. It is: what happens to everyone else?
 *
 * Two distinct answers are required, and conflating them is a security bug:
 *
 *   - Anonymous        -> 401 Unauthorized  (we do not know who you are)
 *   - Wrong role       -> 403 Forbidden     (we know who you are; you may not)
 *
 * A 401 for an authenticated Client would be a lie that breaks the frontend's
 * "session expired" handling; a 403 for an anonymous caller would confirm that
 * /api/admin exists.
 *
 * Every negative case is paired with a positive one, so a router that simply
 * rejects EVERYONE cannot pass this suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app, resetDatabase } from '../../phase1/setup/db.js';
import { createClient, isError } from '../../phase1/helpers/client.js';
import { adminSession, createClientAccount, createSimpleWorld, createUser, uniqueKey } from '../../phase1/helpers/fixtures.js';

let world;
let manager;
let staff;
let admin;

beforeAll(async () => {
  await resetDatabase();
  world = await createSimpleWorld({ stock: 30 });
  admin = world.admin;

  // A Manager owns the one warehouse; Staff is granted access to it.
  manager = await createUser(admin.api, { role: 'Manager', warehouse_ids: [world.warehouse.id] });
  staff = await createUser(admin.api, { role: 'Staff', warehouse_ids: [world.warehouse.id] });

  const managerApi = createClient(app);
  await managerApi.login(manager.email, manager.password);
  manager.api = managerApi;

  const staffApi = createClient(app);
  await staffApi.login(staff.email, staff.password);
  staff.api = staffApi;
});

afterAll(async () => {
  const { closePool } = await import('../../phase1/setup/db.js');
  await closePool();
});

// ---------------------------------------------------------------------------
// /api/admin/*
// ---------------------------------------------------------------------------

describe('Phase 4 :: RBAC on /api/admin/*', () => {
  const ADMIN_ROUTES = ['/api/admin/overview', '/api/admin/users'];

  for (const path of ADMIN_ROUTES) {
    it(`rejects an anonymous caller on ${path} with 401`, async () => {
      const anonymous = createClient(app);
      const response = await anonymous.get(path);

      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('requestId');
    });

    it(`rejects a Client on ${path} with 403 INSUFFICIENT_ROLE`, async () => {
      const response = await world.client.api.get(path);

      expect(response.status).toBe(403);
      expect(isError(response, 'INSUFFICIENT_ROLE')).toBe(true);
      expect(response.body.error.message).toMatch(/requires one of: Admin/);
    });

    it(`rejects a Manager on ${path} with 403`, async () => {
      const response = await manager.api.get(path);
      expect(response.status).toBe(403);
      expect(isError(response, 'INSUFFICIENT_ROLE')).toBe(true);
    });

    it(`rejects Staff on ${path} with 403`, async () => {
      const response = await staff.api.get(path);
      expect(response.status).toBe(403);
      expect(isError(response, 'INSUFFICIENT_ROLE')).toBe(true);
    });

    it(`allows an Admin on ${path} (the guard is not simply "deny all")`, async () => {
      const response = await admin.api.get(path);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
    });
  }

  it('mounts the role check before any handler, so a new admin route is protected', async () => {
    // A path that does not exist still returns 401/403 rather than 404: the gate
    // runs first, which is what proves the guard is router-level.
    const anonymous = createClient(app);
    expect((await anonymous.get('/api/admin/not-a-real-route')).status).toBe(401);
    expect((await world.client.api.get('/api/admin/not-a-real-route')).status).toBe(403);
  });

  it('does not leak the user list to a Client', async () => {
    const response = await world.client.api.get('/api/admin/users');
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toMatch(/@stockpulse\.test/);
  });

  it('returns 404 for a user id that does not exist, but only to an Admin', async () => {
    const missing = await admin.api.get('/api/admin/users/999999');
    expect(missing.status).toBe(404);

    const asClient = await world.client.api.get('/api/admin/users/999999');
    expect(asClient.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// /api/users/* (legacy admin surface) stays equally locked
// ---------------------------------------------------------------------------

describe('Phase 4 :: RBAC on /api/users/*', () => {
  it('denies user administration to every non-Admin role', async () => {
    for (const api of [world.client.api, manager.api, staff.api]) {
      const list = await api.get('/api/users');
      expect(list.status).toBe(403);

      const create = await api.post('/api/users', {
        name: 'Escalated',
        email: `escalated-${uniqueKey()}@stockpulse.test`,
        password: 'Password1234',
        role: 'Admin',
      });
      expect(create.status).toBe(403);
    }
  });

  it('lets an Admin create an internal account', async () => {
    const email = `created-${uniqueKey()}@stockpulse.test`;
    const response = await admin.api.post('/api/users', {
      name: 'New Manager',
      email,
      password: 'Password1234',
      role: 'Manager',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.role).toBe('Manager');
  });

  it('refuses to demote the last active administrator', async () => {
    const lone = await adminSession();
    const response = await lone.api.patch(`/api/users/${lone.id}`, { role: 'Staff' });

    // Without this guard a single mis-click makes the system unadministrable.
    expect(response.status).toBe(409);
    expect(isError(response, 'LAST_ADMIN')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Privilege changes take effect immediately
// ---------------------------------------------------------------------------

describe('Phase 4 :: privilege revocation is immediate', () => {
  it('stops honouring an existing session the moment the role is downgraded', async () => {
    const creator = await adminSession();
    const tempAdmin = await createUser(creator.api, { role: 'Admin' });

    const session = createClient(app);
    await session.login(tempAdmin.email, tempAdmin.password);

    // The token claims Admin, but the role is re-read from the database on every
    // request -- so this works...
    expect((await session.get('/api/admin/overview')).status).toBe(200);

    // ...and this must not, even though the JWT payload still says "Admin" and
    // the token has not expired.
    await creator.api.patch(`/api/users/${tempAdmin.id}`, { role: 'Client' });

    const after = await session.get('/api/admin/overview');
    expect(after.status).toBe(401);
    expect(isError(after, 'TOKEN_REVOKED')).toBe(true);
  });

  it('stops honouring a session the moment the account is deactivated', async () => {
    const creator = await adminSession();
    const user = await createUser(creator.api, { role: 'Staff' });

    const session = createClient(app);
    await session.login(user.email, user.password);
    expect((await session.get('/api/auth/me')).status).toBe(200);

    await creator.api.patch(`/api/users/${user.id}`, { is_active: false });

    const after = await session.get('/api/auth/me');
    expect(after.status).toBe(403);
    expect(isError(after, 'ACCOUNT_DISABLED')).toBe(true);
  });

  it('does not let a forged role claim in a token grant Admin', async () => {
    const jsonwebtoken = (await import('jsonwebtoken')).default;
    const env = (await import('../../../src/config/env.js')).env;
    const client = await createClientAccount();

    // Signed with the real secret -- the strongest attacker position short of
    // key compromise. It must still fail, because the role is never read from
    // the token.
    const forged = jsonwebtoken.sign({ role: 'Admin' }, env.JWT_SECRET, {
      subject: String(client.id),
      expiresIn: '15m',
    });

    const session = createClient(app);
    session.useBearer(forged);

    const me = await session.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.role).toBe('Client');

    expect((await session.get('/api/admin/overview')).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Warehouse scoping (IDOR)
// ---------------------------------------------------------------------------

describe('Phase 4 :: warehouse scoping closes the IDOR gap a role check leaves open', () => {
  it('denies a Client all inventory access, whatever the role allows elsewhere', async () => {
    const response = await world.client.api.get('/api/inventory');
    expect(response.status).toBe(403);
  });

  it('denies a Manager access to a warehouse they are not responsible for', async () => {
    const other = await createSimpleWorld({ stock: 5 });

    const response = await manager.api.get(`/api/warehouses/${other.warehouse.id}/inventory`);
    expect(response.status).toBe(403);
    expect(isError(response, 'WAREHOUSE_FORBIDDEN')).toBe(true);

    // The same request against their own warehouse must still work, so this
    // proves scoping rather than a blanket refusal.
    const own = await manager.api.get(`/api/warehouses/${world.warehouse.id}/inventory`);
    expect(own.status).toBe(200);

    // Flat listing must never yield rows from the foreign warehouse: every
    // returned row is scoped to the owner's own id only.
    const flat = await manager.api.get('/api/inventory?limit=100');
    expect(flat.status).toBe(200);
    expect(flat.body.data.every((row) => row.warehouse.id === world.warehouse.id)).toBe(true);
  });

  it('does not leak another warehouse\u2019s stock through the flat listing', async () => {
    const other = await createSimpleWorld({ stock: 7 });

    const response = await manager.api.get('/api/inventory?limit=100');
    expect(response.status).toBe(200);

    // Every row on the response must be scoped to the owner's own warehouse,
    // never another one. With no rows above the cap, `every` here is a no-op and
    // the assertion still proves no leakage occurred.
    const ids = response.body.data.map((row) => row.warehouse.id);
    expect(ids).toEqual([world.warehouse.id]);
  });

  it('revokes warehouse access immediately after the grant is withdrawn', async () => {
    const creator = await adminSession();
    const warehouse = await import('../../phase1/helpers/fixtures.js').then((m) => m.createWarehouse(creator.api));

    const user = await createUser(creator.api, { role: 'Staff', warehouse_ids: [warehouse.id] });
    const session = createClient(app);
    await session.login(user.email, user.password);

    expect((await session.get(`/api/warehouses/${warehouse.id}/inventory`)).status).toBe(200);

    await creator.api.post(`/api/users/${user.id}/warehouse-access`, { revoke: [warehouse.id] });

    expect((await session.get(`/api/warehouses/${warehouse.id}/inventory`)).status).toBe(403);
  });

  it('hides an out-of-scope order behind 404 instead of 403 (no enumeration)', async () => {
    const placed = await world.client.api.post('/api/orders', {
      items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 1 }],
    });
    expect(placed.status).toBe(201);

    const outsider = await createSimpleWorld({ stock: 3 });
    const response = await outsider.client.api.get(`/api/orders/${placed.body.data.id}`);

    // A 403 would confirm the id exists; a 404 reveals nothing.
    expect(response.status).toBe(404);
    expect(isError(response, 'ORDER_NOT_FOUND')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mass-assignment / over-posting
// ---------------------------------------------------------------------------

describe('Phase 4 :: mass-assignment defence', () => {
  it('ignores unknown fields rather than writing them', async () => {
    const email = `massassign-${uniqueKey()}@client.test`;
    const api = createClient(app);

    const response = await api.post('/api/auth/register', {
      name: 'Mass Assign',
      email,
      password: 'Password1234',
      // None of these exist on registerSchema; Zod strips them.
      role: 'Admin',
      is_active: true,
      token_version: 99,
      id: 1,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.role).toBe('Client');

    const stored = await import('../../phase1/setup/db.js').then((m) =>
      m.query('SELECT role, token_version, is_active FROM users WHERE email = $1', [email]),
    );
    expect(stored.rows[0]).toMatchObject({ role: 'Client', token_version: 0, is_active: true });
  });

  it('refuses to let an Admin patch a field that is not part of the update schema', async () => {
    const target = await createClientAccount();

    const response = await admin.api.patch(`/api/users/${target.id}`, {
      name: 'Renamed Legitimately',
      password_hash: 'injected',
      token_version: 12345,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe('Renamed Legitimately');

    const stored = await import('../../phase1/setup/db.js').then((m) =>
      m.query('SELECT password_hash, token_version FROM users WHERE id = $1', [target.id]),
    );
    expect(stored.rows[0].password_hash).not.toBe('injected');
    expect(Number(stored.rows[0].token_version)).toBe(0);
  });
});
