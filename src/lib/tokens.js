/**
 * Access-token issuing and cookie transport.
 */
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * The payload is deliberately thin: `sub` (user id), `tv` (token version) and
 * `role` for cheap UI hints. Role is *not* trusted from the token on protected
 * requests -- see middleware/authenticate.js.
 */
export function signAccessToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role, tv: user.token_version }, env.JWT_SECRET, {
    expiresIn: env.JWT_TTL,
    issuer: 'stockpulse',
  });
}

export function verifyAccessToken(token) {
  // Throws JsonWebTokenError / TokenExpiredError, mapped by authenticate().
  return jwt.verify(token, env.JWT_SECRET, { issuer: 'stockpulse' });
}

/** Parses a duration such as "15m", "1h", "30d" into milliseconds. */
export function ttlToMs(ttl, fallbackMs = 15 * 60 * 1000) {
  const match = /^(\d+)\s*([smhd])$/i.exec(String(ttl).trim());
  if (!match) return fallbackMs;
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase()];
  return Number(match[1]) * unitMs;
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: env.isProduction ? 'none' : 'lax',
    secure: env.isProduction || env.COOKIE_SECURE,
    path: '/',
    // Kept in step with the token lifetime so the browser cannot hold a session
    // cookie longer than the token inside it is valid.
    maxAge: ttlToMs(env.JWT_TTL),
  };
}

export function extractToken(req) {
  const fromCookie = req.cookies?.[env.COOKIE_NAME];
  if (fromCookie) return { token: fromCookie, source: 'cookie' };

  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) {
    return { token: header.slice(7).trim(), source: 'bearer' };
  }

  return { token: null, source: null };
}