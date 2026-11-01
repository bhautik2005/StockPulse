/**
 * Password-reset token generation and hashing.
 *
 * Two properties matter and are easy to get wrong later:
 *
 *  1. The token comes from `crypto.randomBytes`, never `Math.random()`. The
 *     latter is a predictable PRNG: an attacker who observes a few outputs can
 *     reconstruct the sequence and mint their own valid reset link.
 *
 *  2. Only the SHA-256 digest is persisted. The raw token is shown exactly once,
 *     in the email. A read-only database compromise therefore yields no usable
 *     links -- the stored value cannot be turned back into one.
 *
 * A plain SHA-256 (rather than bcrypt) is the correct choice here, unlike for
 * passwords: the input is 256 bits of true randomness, so there is no dictionary
 * to attack and no reason to pay a slow-hash cost on every lookup.
 */
import { createHash, randomBytes } from 'node:crypto';

/** 32 bytes = 256 bits of entropy, hex-encoded to 64 characters. */
const TOKEN_BYTES = 32;

/** The exact shape `generateResetToken()` produces: lowercase hex, 64 chars. */
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Mints a new token.
 *
 * Returns both halves together so a caller cannot accidentally store the raw
 * value or email the hash.
 */
export function generateResetToken() {
  const raw = randomBytes(TOKEN_BYTES).toString('hex');
  return { raw, hash: hashResetToken(raw) };
}

/** Digests a raw token for storage or lookup. */
export function hashResetToken(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Rejects anything that cannot be one of our tokens before it reaches the
 * database.
 *
 * This is a shape check, not a security boundary -- an attacker guessing hashes
 * gains nothing from the unique index either way. It exists so malformed input
 * (an empty string, a 10 MB body, "undefined") fails fast and never becomes a
 * query parameter.
 */
export function isWellFormedResetToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}