/**
 * Warehouse routes. Access is always scope-checked; the nested inventory route
 * is the classic IDOR surface, so it is guarded explicitly.
 */
import { Router } from 'express';
import { z } from 'zod';

import { ROLES } from '../../config/env.js';
import { idParam } from '../../lib/commonSchemas.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import {
  attachWarehouseScope,
  requireRole,
  requireWarehouseAccess,
} from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { listInventoryQuery } from '../inventory/inventory.schemas.js';
import * as inventoryService from '../inventory/inventory.service.js';
import {
  createWarehouseSchema,
  listWarehousesQuery,
  updateWarehouseSchema,
} from './warehouses.schemas.js';
import * as service from './warehouses.service.js';

export const warehousesRouter = Router();

warehousesRouter.use(
  authenticate,
  requireRole(ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF),
  attachWarehouseScope,
);

const ledgerQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

warehousesRouter.get(
  '/',
  validate({ query: listWarehousesQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, include_inactive: includeInactive } = req.validatedQuery;
    const { rows, total } = await service.listWarehouses({
      scope: req.warehouseScope,
      includeInactive,
      limit,
      offset: (page - 1) * limit,
    });
    res.json({ data: rows, meta: { page, limit, total } });
  }),
);

/** Admin only: creating a warehouse is an infrastructure decision. */
warehousesRouter.post(
  '/',
  requireRole(ROLES.ADMIN),
  validate({ body: createWarehouseSchema }),
  asyncHandler(async (req, res) => {
    const warehouse = await service.createWarehouse({ input: req.body });
    res.status(201).json({ data: warehouse });
  }),
);

warehousesRouter.get(
  '/:id',
  validate({ params: idParam }),
  requireWarehouseAccess((req) => req.params.id),
  asyncHandler(async (req, res) => {
    const warehouse = await service.getWarehouse({
      scope: req.warehouseScope,
      warehouseId: req.params.id,
    });
    res.json({ data: warehouse });
  }),
);

warehousesRouter.patch(
  '/:id',
  requireRole(ROLES.ADMIN),
  validate({ params: idParam, body: updateWarehouseSchema }),
  asyncHandler(async (req, res) => {
    const warehouse = await service.updateWarehouse({
      warehouseId: req.params.id,
      patch: req.body,
    });
    res.json({ data: warehouse });
  }),
);

/**
 * Stock held at one warehouse.
 *
 * requireWarehouseAccess turns "a Manager reading a warehouse they do not own"
 * into a 403 instead of a silent empty list, which is what makes the IDOR
 * boundary observable (and testable).
 */
warehousesRouter.get(
  '/:id/inventory',
  validate({ params: idParam, query: listInventoryQuery }),
  requireWarehouseAccess((req) => req.params.id),
  asyncHandler(async (req, res) => {
    const filters = { ...req.validatedQuery, warehouse_id: Number(req.params.id) };
    const { rows, total } = await inventoryService.listStock({
      scope: req.warehouseScope,
      filters,
    });
    res.json({ data: rows, meta: { page: filters.page, limit: filters.limit, total } });
  }),
);

warehousesRouter.get(
  '/:id/ledger',
  validate({ params: idParam, query: ledgerQuery }),
  requireWarehouseAccess((req) => req.params.id),
  asyncHandler(async (req, res) => {
    const rows = await service.listWarehouseLedger({
      scope: req.warehouseScope,
      warehouseId: req.params.id,
      limit: req.validatedQuery.limit,
    });
    res.json({ data: rows, meta: { count: rows.length } });
  }),
);

/** Fulfilment queue for this warehouse. */
warehousesRouter.get(
  '/:id/orders',
  validate({ params: idParam, query: ledgerQuery }),
  requireWarehouseAccess((req) => req.params.id),
  asyncHandler(async (req, res) => {
    const { rows, total } = await service.listWarehouseOrders({
      scope: req.warehouseScope,
      warehouseId: req.params.id,
      limit: req.validatedQuery.limit,
    });
    res.json({ data: rows, meta: { total } });
  }),
);