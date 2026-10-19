/**
 * Order routes. The controller layer lives inline here: each handler is a few
 * lines that validate, delegate to the service and shape the response.
 */
import { Router } from 'express';

import { env, ROLES } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';
import { uuidString } from '../../lib/commonSchemas.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { attachWarehouseScope, requireRole } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { idParam } from '../../lib/commonSchemas.js';
import * as service from './orders.service.js';
import {
  cancelOrderSchema,
  createOrderSchema,
  listOrdersQuery,
  updateStatusSchema,
} from './orders.schemas.js';

export const ordersRouter = Router();

// Every order route requires a session and a resolved warehouse scope.
ordersRouter.use(authenticate, attachWarehouseScope);

const limits = {
  maxLines: env.ORDER_MAX_LINES,
  maxPerLine: env.ORDER_MAX_QUANTITY_PER_LINE,
};

/**
 * Places an order.
 *
 * 201 on creation, 200 with `idempotent_replay: true` when the same
 * Idempotency-Key was already used. The distinction matters to a client: the
 * second response means "your earlier attempt succeeded", not "do it again".
 */
ordersRouter.post(
  '/',
  requireRole(ROLES.CLIENT, ROLES.STAFF, ROLES.ADMIN),
  validate({ body: createOrderSchema }),
  asyncHandler(async (req, res) => {
    const headerKey = req.get('idempotency-key');

    if (headerKey) {
      const parsed = uuidString.safeParse(headerKey);
      if (!parsed.success) {
        throw AppError.badRequest('Idempotency-Key header must be a UUID', 'INVALID_IDEMPOTENCY_KEY');
      }
    }

    const { order, replayed } = await service.createOrder({
      actor: req.user,
      items: req.body.items,
      currency: req.body.currency ?? 'USD',
      idempotencyKey: headerKey ?? req.body.idempotency_key,
      limits,
    });

    res.status(replayed ? 200 : 201).json({
      data: order,
      meta: { idempotent_replay: replayed },
    });
  }),
);

/** Lists orders visible to the caller (own / warehouse-scoped / all). */
ordersRouter.get(
  '/',
  validate({ query: listOrdersQuery }),
  asyncHandler(async (req, res) => {
    const filters = req.validatedQuery;
    const { rows, total } = await service.listOrders({
      actor: req.user,
      scope: req.warehouseScope,
      filters,
    });

    res.json({
      data: rows.map((row) => ({
        id: row.id,
        order_number: row.order_number,
        status: row.status,
        total_amount: row.total_amount,
        currency: row.currency,
        client_name: row.client_name,
        line_count: row.line_count,
        created_at: row.created_at,
      })),
      meta: { page: filters.page, limit: filters.limit, total },
    });
  }),
);

ordersRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const order = await service.getOrder({
      actor: req.user,
      orderId: req.params.id,
      scope: req.warehouseScope,
    });
    res.json({ data: order });
  }),
);

/**
 * Cancels an order and returns its stock. This is the only cancellation path --
 * the status endpoint explicitly refuses 'Cancelled'.
 */
ordersRouter.post(
  '/:id/cancel',
  validate({ params: idParam, body: cancelOrderSchema }),
  asyncHandler(async (req, res) => {
    const order = await service.cancelOrder({
      actor: req.user,
      orderId: req.params.id,
      reason: req.body.reason,
      scope: req.warehouseScope,
    });
    res.json({ data: order });
  }),
);

/** Advances an order through Processing -> Shipped -> Delivered. */
ordersRouter.patch(
  '/:id/status',
  requireRole(ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF),
  validate({ params: idParam, body: updateStatusSchema }),
  asyncHandler(async (req, res) => {
    const order = await service.updateOrderStatus({
      actor: req.user,
      orderId: req.params.id,
      status: req.body.status,
      scope: req.warehouseScope,
    });
    res.json({ data: order });
  }),
);