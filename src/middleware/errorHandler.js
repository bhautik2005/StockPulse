/**
 * Converts anything thrown anywhere in the request pipeline into a single,
 * predictable JSON error envelope:
 *
 *   { "error": { "code": "...", "message": "...", "details": ..., "requestId": "..." } }
 *
 * Database-level failures are translated rather than leaked: a raw Postgres
 * message such as `duplicate key value violates unique constraint "orders_..."`
 * tells the client nothing useful and exposes internals.
 */
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../errors/AppError.js';
import { logger } from '../lib/logger.js';

/** SQLSTATE -> AppError translations. Quoted keys: SQLSTATEs such as "22P02"
 *  are not valid unquoted JavaScript property names. */
const PG_ERROR_MAP = {
  '23505': (e) =>
    AppError.conflict('A record with these unique values already exists', 'DUPLICATE_KEY', {
      constraint: e.constraint,
    }),
  '23514': (e) =>
    AppError.badRequest(
      `Value rejected by the database (constraint ${e.constraint ?? 'unknown'})`,
      'CONSTRAINT_VIOLATION',
      { constraint: e.constraint },
    ),
  '23503': (e) =>
    AppError.conflict(
      'Operation would break a reference: the related record is missing or still in use',
      'REFERENCE_VIOLATION',
      { constraint: e.constraint },
    ),
  // 23001 is what ON DELETE RESTRICT actually raises (23503 is the deferred /
  // immediate-check variant). Missing this mapping turns "you cannot delete a
  // warehouse that still holds stock" into a 500.
  '23001': (e) =>
    AppError.conflict(
      'This record is still referenced by other records and cannot be deleted',
      'REFERENCE_VIOLATION',
      { constraint: e.constraint },
    ),
  '23502': (e) =>
    AppError.badRequest('A required field was missing', 'MISSING_FIELD', { column: e.column }),
  '22P02': () => AppError.badRequest('Malformed value: expected an integer, uuid or numeric'),
  // 22021 is "invalid byte sequence for encoding UTF8" -- in practice a null byte
  // (\u0000), which PostgreSQL cannot store in any text type. Without this
  // mapping a single JSON string containing U+0000 turns into a 500, so any
  // caller can manufacture an internal error and bury the real ones in the logs.
  // src/lib/commonSchemas.js `safeText` rejects it earlier; this is the backstop
  // for a value that reaches the database by some other route.
  '22021': () =>
    AppError.badRequest(
      'Text contains a character that cannot be stored (a null byte)',
      'INVALID_TEXT_ENCODING',
    ),
  '40001': () => AppError.conflict('Concurrent update detected, please retry', 'SERIALIZATION_FAILURE'),
  '40P01': () => AppError.conflict('Concurrent update detected, please retry', 'DEADLOCK_DETECTED'),
  '55P03': () => AppError.conflict('Could not lock the requested record in time', 'LOCK_TIMEOUT'),
  '57014': () =>
    new AppError(503, 'QUERY_TIMEOUT', 'The database took too long to answer; the operation was aborted'),
};

function normalise(error) {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return AppError.unprocessable(
      'Request validation failed',
      'VALIDATION_FAILED',
      error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
    );
  }

  if (error?.code && PG_ERROR_MAP[error.code]) {
    return PG_ERROR_MAP[error.code](error);
  }

  // node-postgres surfaces pool acquisition failures as a plain Error string.
  if (typeof error?.message === 'string' && error.message.includes('timeout exceeded when trying to connect')) {
    return new AppError(503, 'DB_POOL_EXHAUSTED', 'The server is busy, please retry shortly');
  }

  if (error?.type === 'entity.too.large') {
    return AppError.badRequest('Request payload is too large', 'PAYLOAD_TOO_LARGE', {
      limit: error.limit,
    });
  }

  if (error instanceof SyntaxError && 'body' in error) {
    return AppError.badRequest('Request body is not valid JSON');
  }

  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

// eslint-disable-next-line no-unused-vars -- Express requires the 4-argument signature.
export function errorHandler(error, req, res, next) {
  const appError = normalise(error);

  if (appError.statusCode >= 500) {
    logger.error('request failed', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      code: appError.code,
      error: error?.message,
      stack: env.isProduction ? undefined : error?.stack,
    });
  } else {
    logger.warn('request rejected', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: appError.statusCode,
      code: appError.code,
    });
  }

  // Internal errors never leak their message in production.
  const message =
    appError.statusCode >= 500 && env.isProduction ? 'An unexpected error occurred' : appError.message;

  res.status(appError.statusCode).json({
    error: {
      code: appError.code,
      message,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
      requestId: req.id,
    },
  });
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No route matches ${req.method} ${req.originalUrl}`,
      requestId: req.id,
    },
  });
}