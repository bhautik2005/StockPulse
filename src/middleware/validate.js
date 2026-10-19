/**
 * Request validation at the HTTP boundary.
 *
 * Rules are declared once as Zod schemas and enforced before any SQL runs, so
 * services can assume their inputs are already well-formed. `strip` semantics
 * (the Zod default) also means unknown fields are dropped: a client cannot
 * smuggle `role: 'Admin'` into a profile update.
 */
import { AppError } from '../errors/AppError.js';

function issuesOf(result) {
  return result.error.issues.map((i) => ({
    path: i.path.join('.') || '(root)',
    message: i.message,
  }));
}

/**
 * @param {{ body?: import('zod').ZodTypeAny, params?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny }} schemas
 */
export function validate(schemas = {}) {
  return (req, _res, next) => {
    try {
      if (schemas.body) {
        const result = schemas.body.safeParse(req.body);
        if (!result.success) {
          throw AppError.unprocessable('Invalid request body', 'VALIDATION_FAILED', issuesOf(result));
        }
        req.body = result.data;
      }

      if (schemas.params) {
        const result = schemas.params.safeParse(req.params);
        if (!result.success) {
          throw AppError.badRequest('Invalid path parameters', 'VALIDATION_FAILED', issuesOf(result));
        }
        req.params = result.data;
      }

      if (schemas.query) {
        const result = schemas.query.safeParse(req.query);
        if (!result.success) {
          throw AppError.badRequest('Invalid query parameters', 'VALIDATION_FAILED', issuesOf(result));
        }
        // Express 4 exposes req.query as a getter; assign onto a plain holder
        // instead of fighting the property descriptor.
        Object.defineProperty(req, 'validatedQuery', {
          value: result.data,
          writable: true,
          configurable: true,
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}