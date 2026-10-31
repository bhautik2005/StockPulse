/**
 * P0 :: permanent deletion of deactivated users.
 *
 * The feature is a privilege-escalation surface, so the tests are mostly about
 * what must be REFUSED. Each guard is checked through the real HTTP API rather
 * than by calling the service directly, because the requirement is that the
 * rules hold for a crafted request and not just for a hidden button.
 *
 * The last group covers the data-integrity promise: the account disappears, but
 * orders and stock history are never removed as a side effect.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { query, resetDatabase, startServer } from './helpers/harness.js';
import { createWorld, uniqueKey } from './helpers/fixtures.js';

const PASSWORD = 'correct-horse-battery';

describe('P0 :: permanent user deletion', () => {
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

  /** Creates an account through the admin API and returns its id. */
  async function makeUser(role) {
    const email = `${uniqueKey('del').toLowerCase()}@acme.test`;
    const created = await world.admin.api.post('/api/users', {
      name: `Delete Me ${role}`,
      email,
      password: PASSWORD,
      role,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return { id: created.body.data.id, email };
  }

  async function deactivate(id) {
    const res = await world.admin.api.patch(`/api/users/${id}`, { is_active: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }

  describe('authorisation', () => {
    it('refuses a non-admin caller', async () => {
      const target = await makeUser('Client');
      await deactivate(target.id);

      for (const api of [world.staff.nairobi.api, world.clients.acme.api]) {
        const res = await api.delete(`/api/users/${target.id}`);
        assert.equal(res.status, 403, 'only administrators may delete accounts');
      }

      // Nothing was removed by the refused attempts.
      const { rows } = await query('SELECT deleted_at FROM users WHERE id = $1', [target.id]);
      assert.equal(rows[0].deleted_at, null);
    });

    it('refuses an unauthenticated caller', async () => {
      const { createApiClient } = await import('./helpers/api.js');
      const anon = createApiClient(server.baseUrl);
      const target = await makeUser('Client');
      await deactivate(target.id);

      const res = await anon.delete(`/api/users/${target.id}`);
      assert.equal(res.status, 401);
    });
  });

  describe('refused targets', () => {
    it('refuses to delete an active account', async () => {
      const target = await makeUser('Client');

      const res = await world.admin.api.delete(`/api/users/${target.id}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'USER_ACTIVE');
    });

    it('refuses to delete an administrator, even when disabled', async () => {
      const target = await makeUser('Admin');
      await deactivate(target.id);

      const res = await world.admin.api.delete(`/api/users/${target.id}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'PROTECTED_ACCOUNT');
    });

    // Staff used to be refused here with ROLE_NOT_DELETABLE. They are now
    // deletable on the same terms as Client and Manager, so the case moved to
    // the "successful deletion" group below.

    it('refuses to let an admin delete their own account', async () => {
      const res = await world.admin.api.delete(`/api/users/${world.admin.id}`);
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'CANNOT_DELETE_SELF');
    });
  });

  describe('invalid requests', () => {
    it('returns 404 for a user that does not exist', async () => {
      const res = await world.admin.api.delete('/api/users/99999999');
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'USER_NOT_FOUND');
    });

    it('rejects a non-numeric id with 400', async () => {
      const res = await world.admin.api.delete('/api/users/not-a-number');
      assert.equal(res.status, 400);
    });

    it('rejects a zero or negative id with 400', async () => {
      for (const id of ['0', '-3']) {
        const res = await world.admin.api.delete(`/api/users/${id}`);
        assert.equal(res.status, 400, `id ${id} must be rejected`);
      }
    });
  });

  describe('successful deletion', () => {
    it('deletes a deactivated client and takes them out of every read path', async () => {
      const target = await makeUser('Client');
      await deactivate(target.id);

      const res = await world.admin.api.delete(`/api/users/${target.id}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.id, target.id);

      // Gone from the list the /users page renders.
      const list = await world.admin.api.get('/api/users', { query: { limit: 100 } });
      assert.ok(
        !list.body.data.some((row) => row.id === target.id),
        'a deleted user must not be listed',
      );

      // And unable to sign in, immediately.
      const login = await world.admin.api.post('/api/auth/login', {
        email: target.email,
        password: PASSWORD,
      });
      assert.equal(login.status, 401);

      // Doubly deleting reports "not found" rather than succeeding twice.
      const again = await world.admin.api.delete(`/api/users/${target.id}`);
      assert.equal(again.status, 404);
    });

    it('deletes a deactivated manager and leaves no dangling warehouse assignment', async () => {
      const target = await makeUser('Manager');
      await deactivate(target.id);

      // Put the manager in charge of a warehouse, which is the ON DELETE
      // RESTRICT relationship that would otherwise block a row removal.
      const warehouseId = world.warehouses.nairobi.id;
      await query('UPDATE warehouses SET manager_id = $1 WHERE id = $2', [target.id, warehouseId]);
      await query('INSERT INTO user_warehouses (user_id, warehouse_id) VALUES ($1, $2)', [
        target.id,
        warehouseId,
      ]);

      const res = await world.admin.api.delete(`/api/users/${target.id}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.data.warehouses_released >= 1, 'the managed warehouse must be released');

      const { rows: managed } = await query(
        'SELECT count(*)::int AS n FROM warehouses WHERE manager_id = $1',
        [target.id],
      );
      assert.equal(managed[0].n, 0, 'no warehouse may still point at a deleted manager');

      const { rows: grants } = await query(
        'SELECT count(*)::int AS n FROM user_warehouses WHERE user_id = $1',
        [target.id],
      );
      assert.equal(grants[0].n, 0, 'explicit grants must be removed with the user');

      // The warehouse itself survives.
      const { rows: warehouse } = await query('SELECT id FROM warehouses WHERE id = $1', [warehouseId]);
      assert.equal(warehouse.length, 1);
    });

    /*
     * Staff parity with Client and Manager. Staff are never warehouse managers
     * (warehouses.manager_id points at users of any role, but the app only
     * assigns managers), so the interesting part here is the explicit grants in
     * user_warehouses, which a Staff account accumulates through Access.
     */
    it('deletes a deactivated staff account and clears its warehouse access', async () => {
      const target = await makeUser('Staff');
      await query('INSERT INTO user_warehouses (user_id, warehouse_id) VALUES ($1, $2)', [
        target.id,
        world.warehouses.nairobi.id,
      ]);
      await deactivate(target.id);

      const res = await world.admin.api.delete(`/api/users/${target.id}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.id, target.id);
      assert.equal(res.body.data.role, 'Staff');

      // The account is gone from the page and can no longer authenticate.
      const list = await world.admin.api.get('/api/users', { query: { limit: 100 } });
      assert.ok(
        !list.body.data.some((row) => row.id === target.id),
        'a deleted staff user must not be listed',
      );

      const login = await world.admin.api.post('/api/auth/login', {
        email: target.email,
        password: PASSWORD,
      });
      assert.equal(login.status, 401);

      const { rows: grants } = await query(
        'SELECT count(*)::int AS n FROM user_warehouses WHERE user_id = $1',
        [target.id],
      );
      assert.equal(grants[0].n, 0, 'a deleted staff account must leave no warehouse grants');
    });

    it('still refuses to delete a staff account that is active', async () => {
      const target = await makeUser('Staff');

      const res = await world.admin.api.delete(`/api/users/${target.id}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'USER_ACTIVE');
    });
  });

  describe('staff reactivation', () => {
    it('keeps the role and warehouse assignments when a staff account comes back', async () => {
      const target = await makeUser('Staff');
      await query('INSERT INTO user_warehouses (user_id, warehouse_id) VALUES ($1, $2)', [
        target.id,
        world.warehouses.nairobi.id,
      ]);

      await deactivate(target.id);
      const back = await world.admin.api.patch(`/api/users/${target.id}`, { is_active: true });
      assert.equal(back.status, 200, JSON.stringify(back.body));

      const { rows } = await query('SELECT role, is_active FROM users WHERE id = $1', [target.id]);
      assert.equal(rows[0].is_active, true);
      assert.equal(rows[0].role, 'Staff', 'reactivation must not change the role');

      const { rows: grants } = await query(
        'SELECT warehouse_id FROM user_warehouses WHERE user_id = $1',
        [target.id],
      );
      assert.equal(grants.length, 1, 'reactivation must not drop warehouse access');
      assert.equal(grants[0].warehouse_id, world.warehouses.nairobi.id);

      // Active again, so permanent deletion is refused once more.
      const res = await world.admin.api.delete(`/api/users/${target.id}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'USER_ACTIVE');
    });
  });

  describe('data integrity', () => {
    it('preserves orders, ledger entries and their foreign keys', async () => {
      const { rows: before } = await query(
        `SELECT (SELECT count(*)::int FROM orders) AS orders,
                (SELECT count(*)::int FROM inventory_transactions) AS ledger,
                (SELECT count(*)::int FROM order_status_history) AS history`,
      );

      const target = await makeUser('Client');
      await deactivate(target.id);
      const res = await world.admin.api.delete(`/api/users/${target.id}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const { rows: after } = await query(
        `SELECT (SELECT count(*)::int FROM orders) AS orders,
                (SELECT count(*)::int FROM inventory_transactions) AS ledger,
                (SELECT count(*)::int FROM order_status_history) AS history`,
      );
      assert.deepEqual(after[0], before[0], 'deleting a user must not remove ERP history');

      /*
       * The row is retained and marked deleted rather than removed, because
       * orders.client_id is ON DELETE RESTRICT and points here forever.
       * `deleted_at` is what every read path filters on.
       */
      const { rows: row } = await query(
        'SELECT deleted_at, is_active FROM users WHERE id = $1',
        [target.id],
      );
      assert.ok(row[0].deleted_at, 'the account must be marked as deleted');
      assert.equal(row[0].is_active, false);
    });
  });
});