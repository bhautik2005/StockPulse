/**
 * Inventory business logic.
 *
 * Adjustments are the *only* way stock changes outside of orders, and they all
 * funnel through here so that every movement gets a ledger entry.
 */
import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import { assertWarehouseInScope } from '../../lib/warehouseScope.js';
import * as repo from './inventory.repository.js';

export async function listStock({ scope, filters }) {
  const params = {
    scope,
    warehouseId: filters.warehouse_id,
    productId: filters.product_id,
    lowStock: filters.low_stock,
    search: filters.search,
    limit: filters.limit,
    offset: (filters.page - 1) * filters.limit,
  };

  const [{ rows }, { rows: countRows }] = await Promise.all([
    repo.listStock(pool, params),
    repo.countStock(pool, params),
  ]);

  return { rows, total: countRows[0]?.total ?? 0 };
}

export async function listLowStock({ scope, limit = 50 }) {
  const { rows } = await repo.listLowStock(pool, { scope, limit });
  return rows.map((row) => ({
    warehouse: { id: row.warehouse_id, code: row.warehouse_code, name: row.warehouse_name },
    product: {
      id: row.product_id,
      sku: row.sku,
      name: row.product_name,
      category: row.category,
    },
    quantity: row.quantity,
    reorder_level: row.effective_reorder_level,
    units_below_threshold: row.units_below_threshold,
  }));
}

export async function listLedger({ scope, filters }) {
  const { rows } = await repo.listLedger(pool, {
    scope,
    warehouseId: filters.warehouse_id,
    productId: filters.product_id,
    limit: filters.limit,
  });
  return rows;
}

/**
 * Applies a signed stock adjustment and records it.
 *
 * Refusals are explicit rather than silent:
 *   - a missing stock row with a negative delta is a 409, not a no-op
 *   - an adjustment that would go below zero is a 409 quoting the current level
 */
export async function adjustStock({ actor, scope, input }) {
  const { warehouse_id: warehouseId, product_id: productId, delta, note } = input;

  assertWarehouseInScope(scope, warehouseId);

  return withTransaction(async (db) => {
    // Friendly 404s instead of a raw foreign-key violation.
    const [warehouse, product] = await Promise.all([
      repo.findWarehouse(db, warehouseId),
      repo.findProduct(db, productId),
    ]);

    if (warehouse.rowCount === 0) {
      throw AppError.notFound('Warehouse not found or inactive', 'WAREHOUSE_NOT_FOUND');
    }
    if (product.rowCount === 0) {
      throw AppError.notFound('Product not found or inactive', 'PRODUCT_NOT_FOUND');
    }

    let quantity;

    const updated = await repo.applyDelta(db, { warehouseId, productId, delta });

    if (updated.rowCount > 0) {
      quantity = updated.rows[0].quantity;
    } else {
      const existing = await repo.findStockRow(db, { warehouseId, productId });

      if (existing.rowCount === 0) {
        if (delta < 0) {
          throw AppError.conflict(
            'No stock record exists for this product in this warehouse, so there is nothing to reduce',
            'STOCK_RECORD_NOT_FOUND',
            { warehouse_id: warehouseId, product_id: productId },
          );
        }

        // First receipt for this product/warehouse pair.
        const created = await repo.createStockRow(db, { warehouseId, productId, quantity: delta });

        if (created.rowCount > 0) {
          quantity = created.rows[0].quantity;
        } else {
          // Another transaction created the row first; re-apply the guarded update.
          const retried = await repo.applyDelta(db, { warehouseId, productId, delta });
          if (retried.rowCount === 0) {
            throw AppError.conflict(
              'Adjustment would make stock negative',
              'NEGATIVE_STOCK',
              { warehouse_id: warehouseId, product_id: productId, delta },
            );
          }
          quantity = retried.rows[0].quantity;
        }
      } else {
        const available = existing.rows[0].quantity;
        throw AppError.conflict(
          `Adjustment refused: stock is ${available} and a change of ${delta} would make it negative`,
          'NEGATIVE_STOCK',
          { warehouse_id: warehouseId, product_id: productId, available, delta },
        );
      }
    }

    await repo.insertLedger(db, {
      warehouseId,
      productId,
      delta,
      // Positive changes are receipts, negative ones are corrections. The
      // ledger vocabulary is what makes stock explainable later.
      reason: delta > 0 ? 'receipt' : 'adjustment',
      note,
      actorId: actor.id,
    });

    return {
      warehouse: { id: warehouseId, code: warehouse.rows[0].code, name: warehouse.rows[0].name },
      product: { id: productId, sku: product.rows[0].sku, name: product.rows[0].name },
      delta,
      quantity,
    };
  });
}