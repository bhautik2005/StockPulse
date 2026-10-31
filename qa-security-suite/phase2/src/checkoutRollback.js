/**
 * Phase 2 :: Checkout transaction demo (ACID rollback).
 *
 * A self-contained model of the money path, written so the rollback guarantee is
 * *demonstrable* rather than merely asserted. Every step runs inside the single
 * transaction that `withTransaction` opens; the `payment` callback is injected so
 * a caller can make step 3 fail on purpose and watch steps 1-2 disappear.
 *
 * The sequence mirrors src/modules/orders/orders.service.js deliberately:
 *
 *   1. lock the stock rows          (deterministic order -> no deadlocks)
 *   2. decrement inventory          (the conditional UPDATE is the oversell guard)
 *   3. create the order + its lines
 *   4. call the payment provider     <-- injected, and the usual place to fail
 *   5. write the ledger entry        (the movement is explained in the same commit)
 *   6. write the status history
 *
 * If step 4 or 5 throws, PostgreSQL rolls the whole thing back: no order, no
 * lines, no ledger row, and the stock is exactly where it started. That is the
 * property this module exists to make visible.
 *
 * Run it directly to watch both outcomes against a live database:
 *
 *   node qa-security-suite/phase2/scripts/checkout-rollback.demo.js
 */
import * as ordersRepo from '../../../src/modules/orders/orders.repository.js';

export class PaymentDeclinedError extends Error {
  constructor(message = 'Payment provider declined the charge') {
    super(message);
    this.name = 'PaymentDeclinedError';
    this.code = 'PAYMENT_DECLINED';
  }
}

/**
 * A stand-in for the payment gateway.
 *
 * `outcome: 'approve'` resolves; `'decline'` throws; `'timeout'` throws a
 * transport-shaped error, because a real gateway can fail without ever saying
 * "no" -- and that case must roll back all the same.
 */
export function fakePaymentProvider({ outcome = 'approve' } = {}) {
  return async function charge({ amount, currency }) {
    if (outcome === 'decline') throw new PaymentDeclinedError();
    if (outcome === 'timeout') {
      const error = new Error('ETIMEDOUT: payment provider did not respond');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    return { reference: `pay_${currency}_${amount}_${Date.now()}`, status: 'captured' };
  };
}

/**
 * Runs one checkout inside a single transaction.
 *
 * `withTransaction` defaults to the application's own implementation
 * (src/db/pool.js). It is injectable so a test can supply its own and prove the
 * rollback behaviour without depending on pool configuration.
 *
 * @param {object} params
 * @param {(fn: (db: import('pg').PoolClient) => Promise<any>) => Promise<any>} [params.withTransaction]
 * @param {{id:number, role:string}} params.actor          the buying user
 * @param {Array<{product_id:number, warehouse_id:number, qty:number}>} params.lines
 * @param {(charge: {amount: string, currency: string}) => Promise<any>} params.charge
 * @param {string} [params.currency]
 * @param {string} [params.idempotencyKey]
 */
export async function checkout({
  withTransaction,
  actor,
  lines,
  charge,
  currency = 'USD',
  idempotencyKey,
}) {
  if (!lines?.length) throw new Error('checkout requires at least one line');
  if (typeof charge !== 'function') throw new Error('checkout requires a payment function');

  // Imported lazily so importing this module never constructs a pool.
  const tx = withTransaction ?? (await import('../../../src/db/pool.js')).withTransaction;

  const key = idempotencyKey ?? crypto.randomUUID();

  return tx(async (db) => {
    // Steps 1 & 2 -- reserve the stock. lockInventoryRows takes the row locks in
    // a deterministic order; decrementInventory fails (rowCount mismatch) rather
    // than going negative, which is what makes overselling impossible.
    await ordersRepo.lockInventoryRows(db, lines);

    const decremented = await ordersRepo.decrementInventory(db, lines);
    if (decremented.rowCount !== lines.length) {
      throw Object.assign(new Error('Insufficient stock; the order was not placed'), {
        code: 'INSUFFICIENT_STOCK',
      });
    }

    // Step 3 -- the order header and its lines, priced in SQL from the catalogue.
    const order = await ordersRepo.createOrder(db, {
      clientId: actor.id,
      currency,
      idempotencyKey: key,
      lines,
    });
    await ordersRepo.insertOrderItems(db, order.id, lines);

    // Step 4 -- the external call. Deliberately *inside* the transaction: this
    // is a common design mistake (a slow gateway holds row locks), and it is the
    // cleanest place to demonstrate that a failure here changes nothing.
    const payment = await charge({ amount: order.total_amount, currency });

    // Step 5 -- explain the movement, in the same commit as the movement.
    await ordersRepo.insertLedgerEntries(db, { orderId: order.id, lines, actorId: actor.id });

    // Step 6 -- record the initial transition.
    await ordersRepo.insertStatusHistory(db, {
      orderId: order.id,
      from: null,
      to: 'Pending',
      changedBy: actor.id,
    });

    return { order, payment, idempotencyKey: key };
  });
}
