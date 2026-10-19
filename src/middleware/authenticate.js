/**
 * Authentication middleware.
 *
 * Deliberate design point: the caller's role is re-read from the database on
 * every authenticated request instead of being trusted from the JWT payload.
 *
 * A signed token is a snapshot of the past. If an Admin is demoted to Staff, the
 * token they already hold still claims `role: "Admin"` and stays valid until it
 * expires. Re-reading the row (plus the `token_version` check) means privilege
 * changes and account deactivation take effect on the very next request.
 *
 * The cost is one indexed primary-key lookup per request, which is a trade any
 * authorisation system should be happy to make.
 */
import { query } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import { assertCsrf } from '../lib/csrf.js';
import { extractToken, verifyAccessToken } from '../lib/tokens.js';
import { asyncHandler } from './asyncHandler.js';

export const authenticate = asyncHandler(async (req, _res, next) => {
  const { token, source } = extractToken(req);

  if (!token) {
    throw AppError.unauthorized('Authentication required: send the session cookie or a Bearer token');
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw AppError.unauthorized('Access token has expired', 'TOKEN_EXPIRED');
    }
    throw AppError.unauthorized('Access token is invalid', 'TOKEN_INVALID');
  }

  const { rows } = await query(
    `SELECT id, name, email, role, is_active, token_version
       FROM users
      WHERE id = $1 AND deleted_at IS NULL`,
    [payload.sub],
  );

  const user = rows[0];

  if (!user) {
    throw AppError.unauthorized('This account no longer exists', 'USER_NOT_FOUND');
  }
  if (!user.is_active) {
    throw AppError.forbidden('This account has been disabled', 'ACCOUNT_DISABLED');
  }
  if (Number(user.token_version) !== Number(payload.tv)) {
    throw AppError.unauthorized('Session was revoked, please sign in again', 'TOKEN_REVOKED');
  }

  req.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
  req.authSource = source;

  // Cookie-authenticated mutations must prove they came from our own frontend.
  if (source === 'cookie') {
    assertCsrf(req);
  }

  next();
});

/**
 * Populates `req.user` when a valid session exists but does not reject
 * anonymous callers. Used by routes whose response differs by role.
 */
export const authenticateOptional = asyncHandler(async (req, res, next) => {
  const { token } = extractToken(req);
  if (!token) return next();
  return authenticate(req, res, next);
});