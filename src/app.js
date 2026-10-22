/**
 * Express application assembly.
 */
import { randomUUID } from 'node:crypto';

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { checkDatabase, poolStats } from './db/pool.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { analyticsRouter } from './modules/analytics/analytics.routes.js';
import { authRouter, usersRouter } from './modules/auth/auth.routes.js';
import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { ordersRouter } from './modules/orders/orders.routes.js';
import { catalogRouter, productsRouter } from './modules/products/products.routes.js';
import { warehousesRouter } from './modules/warehouses/warehouses.routes.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Behind a proxy the client IP arrives in X-Forwarded-For; rate limiting and
  // logging depend on trusting exactly one hop.
  if (env.isProduction) app.set('trust proxy', 1);

  // Get allowed origins from environment variables (comma-separated list)
  const baseAllowedOrigins = env.CORS_ORIGIN
    ? env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
    : ['http://localhost:5173'];

  app.use(helmet());
  app.use(
    cors({
      //   // `credentials: true` requires an explicit origin list, never '*'. A
      //   // wildcard here causes browsers to reject the response outright.
      //   origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
      //   credentials: true,
      //   // Explicitly handle preflight requests
      //   methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      //   allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'Idempotency-Key', 'X-Requested-With'],
      //   exposedHeaders: ['X-Request-Id'],
      //   maxAge: 86400, // Cache preflight for 24 hours
      // }),
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps, Postman, or server-to-server requests)
        if (!origin) return callback(null, true);

        if (baseAllowedOrigins.includes(origin)|| origin.endsWith('.vercel.app')) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS policy'), false);
      },
      credentials: true, // Required for cookies and authorization headers
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'Idempotency-Key', 'X-Requested-With'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 86400, // Cache preflight for 24 hours
    })
  );
  // A bounded body size: an unbounded JSON parser is a trivial memory DoS.
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  // Correlation id + one structured log line per request. Being able to follow
  // a single request across the pool, the transaction and the error handler is
  // the difference between debugging and guessing.
  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || randomUUID();
    res.setHeader('x-request-id', req.id);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.info('request', {
        requestId: req.id,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Number(elapsedMs.toFixed(1)),
      });
    });

    next();
  });

  /**
   * Liveness + readiness in one endpoint. It reports pool saturation too:
   * "healthy" while every connection is checked out and a queue is forming is
   * precisely the state that precedes a latency collapse.
   */
  app.get('/health', async (_req, res) => {
    try {
      const database = await checkDatabase();
      res.json({
        status: 'ok',
        database,
        pool: poolStats(),
        uptime_seconds: Math.round(process.uptime()),
        version: process.env.npm_package_version ?? '0.1.0',
      });
    } catch (error) {
      res.status(503).json({
        status: 'degraded',
        error: error.message,
        pool: poolStats(),
      });
    }
  });

  /**
   * A landing route, because the first thing anyone does after `npm run dev` is
   * open the port in a browser. Without this they get a bare 404 and reasonably
   * conclude the server is broken. There is no web UI yet -- the React client is
   * not part of P0 -- so say so instead of implying otherwise.
   */
  app.get('/', (_req, res) => {
    res.json({
      service: 'StockPulse API',
      version: process.env.npm_package_version ?? '0.1.0',
      status: 'ok',
      ui: 'none — this is the API only; use Adminer for a database UI',
      documentation: 'README.md',
      endpoints: { health: '/health', index: '/api' },
      demo_accounts: {
        admin: 'admin@stockpulse.dev / AdminPass1234',
        client: 'client@acme.dev / ClientPass1234',
      },
    });
  });

  /** Endpoint index: makes the API explorable without a separate doc. */
  app.get('/api', (_req, res) => {
    res.json({
      data: {
        auth: ['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/auth/me'],
        users: ['GET /api/users', 'POST /api/users', 'PATCH /api/users/:id', 'POST /api/users/:id/warehouse-access'],
        warehouses: [
          'GET /api/warehouses',
          'POST /api/warehouses',
          'GET /api/warehouses/:id',
          'PATCH /api/warehouses/:id',
          'GET /api/warehouses/:id/inventory',
          'GET /api/warehouses/:id/ledger',
          'GET /api/warehouses/:id/orders',
        ],
        products: ['GET /api/products', 'POST /api/products', 'PATCH /api/products/:id', 'DELETE /api/products/:id'],
        catalog: ['GET /api/catalog', 'GET /api/catalog/:id'],
        inventory: [
          'GET /api/inventory',
          'GET /api/inventory/low-stock',
          'GET /api/inventory/ledger',
          'POST /api/inventory/adjust',
        ],
        orders: [
          'POST /api/orders',
          'GET /api/orders',
          'GET /api/orders/:id',
          'POST /api/orders/:id/cancel',
          'PATCH /api/orders/:id/status',
        ],
        analytics: [
          'GET /api/analytics/summary',
          'GET /api/analytics/sales-trend',
          'GET /api/analytics/top-products',
          'GET /api/analytics/by-warehouse',
        ],
      },
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/warehouses', warehousesRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/analytics', analyticsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}