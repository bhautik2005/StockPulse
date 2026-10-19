/**
 * Typed application errors.
 *
 * Every failure that reaches the client carries a machine-readable `code`, so
 * the UI can branch on behaviour instead of parsing English prose.
 */
export class AppError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = true;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message, code = 'BAD_REQUEST', details = undefined) {
    return new AppError(400, code, message, details);
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHENTICATED') {
    return new AppError(401, code, message);
  }

  static forbidden(message = 'You do not have access to this resource', code = 'FORBIDDEN') {
    return new AppError(403, code, message);
  }

  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new AppError(404, code, message);
  }

  /** 409 = the request is well-formed but conflicts with current state. */
  static conflict(message, code = 'CONFLICT', details) {
    return new AppError(409, code, message, details);
  }

  static unprocessable(message, code = 'UNPROCESSABLE', details) {
    return new AppError(422, code, message, details);
  }
}