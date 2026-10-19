/**
 * Password hashing.
 *
 * bcrypt with a configurable work factor. Note the 72-byte input limit inherent
 * to bcrypt: anything longer is silently truncated when it *should* be rejected,
 * so the request schema caps password length rather than letting two different
 * long passwords hash identically.
 *
 * bcryptjs (a pure-JS implementation of the same algorithm) is used here so the
 * project installs without a native toolchain; swapping in the native `bcrypt`
 * package on Linux/CI is a one-line change.
 */
import bcrypt from 'bcryptjs';

import { env } from '../config/env.js';

export function hashPassword(plain) {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

export function verifyPassword(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}

/**
 * Pre-computed hash of a throwaway value, compared against when the email does
 * not exist. Without it, "user not found" returns noticeably faster than "wrong
 * password", which leaks which emails are registered.
 */
export const DUMMY_HASH = bcrypt.hashSync('invalid-password-placeholder', env.BCRYPT_ROUNDS);