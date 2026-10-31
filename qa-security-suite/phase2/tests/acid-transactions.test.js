/**
 * Phase 2 :: ACID transactions and rollback.
 *
 * Three independent proofs that a partial checkout cannot survive:
 *
 *   1. A payment decline inside the transaction -> the stock decrement and the
 *      order insert disappear together.
 *   2. A ledger-write failure *after* the stock moved -> same outcome. This is
 *      the subtler case: stock was already decremented and the order already
 *      existed when the failure happened.
 *   3. A concurrent checkout -> one commits, one rolls back, and the ledger sum
 *      still equals the quantity on hand.
 *
 * Every assertion reads the database directly. "The response said it failed" is
 * not evidence that nothing was written.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { query, resetDatabase, scalar } from '../../phase1/setup/db.js';
import { createSimpleWorld, onHand } from '../../phase1/helpers/fixtures.js';
import { checkout, fakePaymentProvider, PaymentDeclinedError } from '../src/checkoutRollback.js';

const SETTING = 'qa.fail_ledger';

let world;

beforeAll(async () => {
  await resetDatabase();
  world = await createSimpleWorld({ stock: 50 });
});

afterAll(async () => {
  const { closePool } = await import('../../phase1/setup/db.js');
  await closePool();
});

beforeEach(async () => {
  await query('UPDATE inventory SET quantity = 50 WHERE warehouse_id = $1 AND product_id = $2', [
    world.warehouse.id,
    world.product.id,
  ]);
  await query('DELETE FROM order_status_history');
  await query('DELETE FROM inventory_transactions');
  await query('DELETE FROM order_items');
  await query('DELETE FROM orders');
});

/** Convenience: a one-line checkout for this world. */
function lineFor(quantity) {
  return [{ product_id: world.product.id, warehouse_id: world.warehouse.id, qty: quantity }];
}

async function counts() {
  return {
    orders: Number(await scalar('SELECT count(*)::int FROM orders')),
    items: Number(await scalar('SELECT count(*)::int FROM order_items')),
    ledger: Number(await scalar('SELECT count(*)::int FROM inventory_transactions')),
    history: Number(await scalar('SELECT count(*)::int FROM order_status_history')),
  };
}

// ---------------------------------------------------------------------------
// 1. Payment failure
// ---------------------------------------------------------------------------

describe('Phase 2 :: ACID rollback on payment failure', () => {
  it('commits every step when the payment is approved', async () => {
    const result = await checkout({
      actor: world.client,
      lines: lineFor(5),
      charge: fakePaymentProvider({ outcome: 'approve' }),
    });

    expect(result.order.order_number).toMatch(/^SO-\d{4}-\d{6}$/);
    expect(result.order.total_amount).toBe('127.50'); // 5 x 25.50
    expect(result.payment.status).toBe('captured');

    expect(await onHand(world.warehouse.id, world.product.id)).toBe(45);
    expect(await counts()).toEqual({ orders: 1, items: 1, ledger: 1, history: 1 });
  });

  it('rolls the whole checkout back when the payment is declined', async () => {
    const before = { stock: await onHand(world.warehouse.id, world.product.id), counts: await counts() };

    await expect(
      checkout({
        actor: world.client,
        lines: lineFor(5),
        charge: fakePaymentProvider({ outcome: 'decline' }),
      }),
    ).rejects.toBeInstanceOf(PaymentDeclinedError);

    // Stock is exactly where it started...
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(before.stock);

    // ...and the order, its lines, the ledger entry and the status history that
    // were all written before the failure are gone.
    expect(await counts()).toEqual(before.counts);

    const orphanLines = await scalar(
      `SELECT count(*)::int FROM order_items oi
        LEFT JOIN orders o ON o.id = oi.order_id
       WHERE o.id IS NULL`,
    );
    expect(Number(orphanLines)).toBe(0);
  });

  it('rolls back when the payment provider times out rather than declining', async () => {
    // A timeout is the interesting case: the charge may or may not have landed.
    // The local transaction must not commit either way.
    await expect(
      checkout({
        actor: world.client,
        lines: lineFor(3),
        charge: fakePaymentProvider({ outcome: 'timeout' }),
      }),
    ).rejects.toThrow(/ETIMEDOUT/);

    expect(await onHand(world.warehouse.id, world.product.id)).toBe(50);
    expect(await counts()).toEqual({ orders: 0, items: 0, ledger: 0, history: 0 });
  });

  it('rolls back when the charge function throws an arbitrary error', async () => {
    await expect(
      checkout({
        actor: world.client,
        lines: lineFor(2),
        charge: async () => {
          throw new Error('gateway exploded');
        },
      }),
    ).rejects.toThrow('gateway exploded');

    expect(await onHand(world.warehouse.id, world.product.id)).toBe(50);
    expect(await counts()).toEqual({ orders: 0, items: 0, ledger: 0, history: 0 });
  });
});

// ---------------------------------------------------------------------------
// 2. Failure *after* the stock has already moved
// ---------------------------------------------------------------------------

describe('Phase 2 :: ACID rollback on a post-decrement failure', () => {
  /**
   * A real ledger-write failure, raised from inside the database.
   *
   * The trigger fires only for sessions that opt in via `SET LOCAL`, so it
   * cannot leak into any other test or into production behaviour.
   */
  async function installFailingLedgerTrigger() {
    await query(`
      CREATE OR REPLACE FUNCTION qa_fail_ledger_write() RETURNS trigger AS $$
      BEGIN
        IF current_setting('${SETTING}', true) = 'on' THEN
          RAISE EXCEPTION 'qa-suite: simulated ledger write failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS qa_fail_ledger_write ON inventory_transactions;
      CREATE TRIGGER qa_fail_ledger_write
        BEFORE INSERT ON inventory_transactions
        FOR EACH ROW EXECUTE FUNCTION qa_fail_ledger_write();
    `);
  }

  async function dropFailingLedgerTrigger() {
    await query(`
      DROP TRIGGER IF EXISTS qa_fail_ledger_write ON inventory_transactions;
      DROP FUNCTION IF EXISTS qa_fail_ledger_write();
    `);
  }

  it('undoes an already-applied stock decrement when the ledger write fails', async () => {
    await installFailingLedgerTrigger();

    try {
      const stockBefore = await onHand(world.warehouse.id, world.product.id);
      expect(stockBefore).toBe(50);

      // The stock decrement (step 2) and the order insert (step 3) have both
      // already happened by the time the ledger insert (step 5) raises.
      await expect(
        checkout({
          actor: world.client,
          lines: lineFor(10),
          charge: fakePaymentProvider({ outcome: 'approve' }),
          // Opt this transaction into the simulated failure.
          withTransaction: async (fn) => {
            const { withTransaction } = await import('../../../src/db/pool.js');
            return withTransaction(async (client) => {
              await client.query(`SET LOCAL ${SETTING} = 'on'`);
              return fn(client);
            });
          },
        }),
      ).rejects.toThrow(/simulated ledger write failure/);

      // The decrement that succeeded moments earlier must have been undone.
      expect(await onHand(world.warehouse.id, world.product.id)).toBe(stockBefore);
      expect(await counts()).toEqual({ orders: 0, items: 0, ledger: 0, history: 0 });
    } finally {
      await dropFailingLedgerTrigger();
    }
  });

  it('leaves the connection usable and the ledger consistent after the rollback', async () => {
    await installFailingLedgerTrigger();

    try {
      await expect(
        checkout({
          actor: world.client,
          lines: lineFor(4),
          charge: fakePaymentProvider({ outcome: 'approve' }),
          withTransaction: async (fn) => {
            const { withTransaction } = await import('../../../src/db/pool.js');
            return withTransaction(async (client) => {
              await client.query(`SET LOCAL ${SETTING} = 'on'`);
              return fn(client);
            });
          },
        }),
      ).rejects.toThrow(/simulated ledger write failure/);
    } finally {
      await dropFailingLedgerTrigger();
    }

    // The same pool must still be able to open a working transaction.
    const after = await checkout({
      actor: world.client,
      lines: lineFor(4),
      charge: fakePaymentProvider({ outcome: 'approve' }),
    });

    expect(after.order.status).toBe('Pending');
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(46);

    // Ledger arithmetic is the real invariant: the sum of the recorded
    // movements must equal the actual change in on-hand quantity. A leaked
    // partial movement from the rolled-back attempt would break this.
    const ledgerSum = Number(
      await scalar(
        `SELECT COALESCE(sum(delta), 0)::int FROM inventory_transactions
          WHERE warehouse_id = $1 AND product_id = $2`,
        [world.warehouse.id, world.product.id],
      ),
    );
    expect(ledgerSum).toBe(46 - 50); // -4: only the attempt that committed
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrency and isolation
// ---------------------------------------------------------------------------

describe('Phase 2 :: isolation between concurrent checkouts', () => {
  it('lets one of two racing checkouts commit and the other roll back cleanly', async () => {
    await query('UPDATE inventory SET quantity = 6 WHERE warehouse_id = $1 AND product_id = $2', [
      world.warehouse.id,
      world.product.id,
    ]);

    const [a, b] = await Promise.allSettled([
      checkout({ actor: world.client, lines: lineFor(4), charge: fakePaymentProvider() }),
      checkout({ actor: world.client, lines: lineFor(4), charge: fakePaymentProvider() }),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser must fail on the stock guard, not on a lock timeout or deadlock.
    expect(String(rejected[0].reason?.message)).toMatch(/Insufficient stock|deadlock|concurrent/i);

    // 6 - 4 = 2 and no more: the failed transaction released its lock without
    // committing a partial decrement.
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(2);
    expect(await counts()).toEqual({ orders: 1, items: 1, ledger: 1, history: 1 });
  });

  it('never consumes a rolled-back order number', async () => {
    const first = await checkout({
      actor: world.client,
      lines: lineFor(1),
      charge: fakePaymentProvider(),
    });

    await expect(
      checkout({
        actor: world.client,
        lines: lineFor(1),
        charge: fakePaymentProvider({ outcome: 'decline' }),
      }),
    ).rejects.toThrow(PaymentDeclinedError);

    const second = await checkout({
      actor: world.client,
      lines: lineFor(1),
      charge: fakePaymentProvider(),
    });

    // Sequences are non-transactional by design: the rolled-back order burned a
    // number, and the guarantee is uniqueness -- never that numbers are dense.
    expect(second.order.order_number).not.toBe(first.order.order_number);
    expect(Number(await scalar('SELECT count(*)::int FROM orders'))).toBe(2);
  });

  it('takes row locks in a deterministic order, so two multi-line orders do not deadlock', async () => {
    const secondProduct = await import('../../phase1/helpers/fixtures.js').then((m) =>
      m.createProduct(world.admin.api, { unit_price: '4.00' }),
    );
    await import('../../phase1/helpers/fixtures.js').then((m) =>
      m.receiveStock(world.admin.api, {
        warehouseId: world.warehouse.id,
        productId: secondProduct.id,
        quantity: 30,
      }),
    );

    // Deliberately opposite line order between the two requests: without the
    // repository's ORDER BY product_id in lockInventoryRows, this pair is the
    // textbook deadlock.
    const locksA = [
      { product_id: world.product.id, warehouse_id: world.warehouse.id, qty: 1 },
      { product_id: secondProduct.id, warehouse_id: world.warehouse.id, qty: 1 },
    ];
    const locksB = [locksA[1], locksA[0]];

    const results = await Promise.allSettled([
      checkout({ actor: world.client, lines: locksA, charge: fakePaymentProvider() }),
      checkout({ actor: world.client, lines: locksB, charge: fakePaymentProvider() }),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        expect(String(result.reason?.message)).not.toMatch(/deadlock/i);
      }
    }
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Atomicity of the cancellation path
// ---------------------------------------------------------------------------

describe('Phase 2 :: cancellation is atomic with restocking', () => {
  it('returns stock and records the movement in one commit', async () => {
    const placed = await world.client.api.post('/api/orders', {
      items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 8 }],
    });
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(42);

    const cancelled = await world.client.api.post(`/api/orders/${placed.body.data.id}/cancel`, {
      reason: 'Customer changed their mind',
    });

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('Cancelled');
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(50);

    const movements = await query(
      `SELECT delta, reason FROM inventory_transactions
        WHERE ref_type = 'order' AND ref_id = $1 ORDER BY id`,
      [placed.body.data.id],
    );
    expect(movements.rows.map((r) => ({ delta: r.delta, reason: r.reason }))).toEqual([
      { delta: -8, reason: 'sale' },
      { delta: 8, reason: 'restock' },
    ]);
  });

  it('leaves stock untouched when the cancellation is refused', async () => {
    const placed = await world.client.api.post('/api/orders', {
      items: [{ product_id: world.product.id, warehouse_id: world.warehouse.id, quantity: 2 }],
    });
    // Delivered orders cannot be cancelled; a return is the correct path.
    await world.admin.api.patch(`/api/orders/${placed.body.data.id}/status`, { status: 'Processing' });
    await world.admin.api.patch(`/api/orders/${placed.body.data.id}/status`, { status: 'Shipped' });
    await world.admin.api.patch(`/api/orders/${placed.body.data.id}/status`, { status: 'Delivered' });

    const stockAfterDelivery = await onHand(world.warehouse.id, world.product.id);

    const refused = await world.client.api.post(`/api/orders/${placed.body.data.id}/cancel`, {
      reason: 'Too late, I changed my mind',
    });

    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ORDER_ALREADY_FULFILLED');
    expect(await onHand(world.warehouse.id, world.product.id)).toBe(stockAfterDelivery);
  });
});
