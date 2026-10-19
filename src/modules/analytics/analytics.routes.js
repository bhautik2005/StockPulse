/**
 * Analytics routes. Internal roles only -- Clients have no dashboard.
 */
import { Router } from 'express';
import { z } from 'zod';

import { ROLES } from '../../config/env.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { attachWarehouseScope, requireRole } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as service from './analytics.service.js';

export const analyticsRouter = Router();

analyticsRouter.use(
  authenticate,
  requireRole(ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF),
  attachWarehouseScope,
);

const trendQuery = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) });
const topQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

analyticsRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    res.json({ data: await service.summary({ scope: req.warehouseScope }) });
  }),
);

analyticsRouter.get(
  '/sales-trend',
  validate({ query: trendQuery }),
  asyncHandler(async (req, res) => {
    const series = await service.salesTrend({
      scope: req.warehouseScope,
      days: req.validatedQuery.days,
    });
    res.json({ data: series, meta: { days: req.validatedQuery.days } });
  }),
);

analyticsRouter.get(
  '/top-products',
  validate({ query: topQuery }),
  asyncHandler(async (req, res) => {
    const rows = await service.topProducts({
      scope: req.warehouseScope,
      limit: req.validatedQuery.limit,
    });
    res.json({ data: rows });
  }),
);

analyticsRouter.get(
  '/by-warehouse',
  asyncHandler(async (req, res) => {
    res.json({ data: await service.byWarehouse({ scope: req.warehouseScope }) });
  }),
);