/**
 * Inventory routes.
 *
 * Read access is limited to internal roles; a Client has no business seeing
 * warehouse stock levels at all (the public catalogue endpoint exists for that).
 */
import { Router } from 'express';
import { z } from 'zod';

import { ROLES } from '../../config/env.js';
import { idParam, positiveInt } from '../../lib/commonSchemas.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { attachWarehouseScope, requireRole, requireWarehouseAccess } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { adjustStockSchema, listInventoryQuery } from './inventory.schemas.js';
import * as service from './inventory.service.js';

export const inventoryRouter = Router();

inventoryRouter.use(
  authenticate,
  requireRole(ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF),
  attachWarehouseScope,
);

const ledgerQuery = z.object({
  warehouse_id: positiveInt.optional(),
  product_id: positiveInt.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Paginated stock, filtered by the caller's warehouse scope. */
inventoryRouter.get(
  '/',
  validate({ query: listInventoryQuery }),
  asyncHandler(async (req, res) => {
    const filters = req.validatedQuery;
    const { rows, total } = await service.listStock({ scope: req.warehouseScope, filters });

    res.json({
      data: rows.map((row) => ({
        warehouse: { id: row.warehouse_id, code: row.warehouse_code, name: row.warehouse_name },
        product: {
          id: row.product_id,
          sku: row.sku,
          name: row.product_name,
          category: row.category,
        },
        quantity: row.quantity,
        reorder_level: row.effective_reorder_level,
        is_low_stock: row.quantity <= row.effective_reorder_level,
        unit_price: row.unit_price,
        stock_value: row.stock_value,
      })),
      meta: { page: filters.page, limit: filters.limit, total },
    });
  }),
);

/** Products at or below their reorder level, worst first. */
inventoryRouter.get(
  '/low-stock',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const rows = await service.listLowStock({ scope: req.warehouseScope, limit });
    res.json({ data: rows, meta: { count: rows.length } });
  }),
);

/** The stock ledger: every movement, with its reason and origin. */
inventoryRouter.get(
  '/ledger',
  validate({ query: ledgerQuery }),
  asyncHandler(async (req, res) => {
    const rows = await service.listLedger({
      scope: req.warehouseScope,
      filters: req.validatedQuery,
    });
    res.json({ data: rows, meta: { count: rows.length } });
  }),
);

/**
 * Manual stock adjustment (receipt, correction, damage write-off).
 * Scoped: a Manager may only adjust their own warehouses.
 */
inventoryRouter.post(
  '/adjust',
  validate({ body: adjustStockSchema }),
  requireWarehouseAccess((req) => req.body.warehouse_id),
  asyncHandler(async (req, res) => {
    const result = await service.adjustStock({
      actor: req.user,
      scope: req.warehouseScope,
      input: req.body,
    });
    res.status(201).json({ data: result });
  }),
);