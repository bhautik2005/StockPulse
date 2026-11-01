/**
 * Authentication and user administration.
 *
 * Two deliberate rules that a generic CRUD implementation usually gets wrong:
 *
 *  1. Public registration can only ever create a Client. If the endpoint
 *     accepted a role, anyone could register as an Admin and own the system.
 *     Internal accounts are created by an Admin through POST /api/users.
 *
 *  2. Privilege changes invalidate existing sessions. Changing a role or
 *     disabling an account bumps `token_version`, so tokens already handed out
 *     stop working immediately instead of remaining valid until they expire.
 */
import { pool, withTransaction } from '../../db/pool.js';
import { env, ROLES } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';
import {
  buildResetUrl,
  passwordChangedEmail,
  passwordResetEmail,
} from '../../lib/emailTemplates.js';
import { logger } from '../../lib/logger.js';
import { sendMailInBackground } from '../../lib/mailer.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../../lib/password.js';
import {
  generateResetToken,
  hashResetToken,
  isWellFormedResetToken,
} from '../../lib/resetTokens.js';
import { signAccessToken } from '../../lib/tokens.js';
import * as repo from './auth.repository.js';

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    is_active: row.is_active,
    ...(row.warehouse_ids !== undefined ? { warehouse_ids: row.warehouse_ids } : {}),
  };
}

function isUniqueViolation(error) {
  return error?.code === '23505';
}

/** Self-service sign-up: Clients only. */
export async function register({ name, email, password: plain }) {
  const passwordHash = await hashPassword(plain);
  try {
    const user = await repo.createUser(pool, { name, email, passwordHash, role: ROLES.CLIENT });
    return publicUser(user);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict('An account with this email already exists', 'EMAIL_IN_USE');
    }
    throw error;
  }
}

/**
 * Verifies credentials.
 *
 * A bcrypt comparison runs even when the email is unknown (against a dummy
 * hash), so both failure modes take the same time and the response cannot be
 * used to discover which emails are registered.
 */
export async function login({ email, password: plain }) {
  const { rows } = await repo.findUserByEmail(pool, email);
  const user = rows[0];

  const passwordMatches = await verifyPassword(plain, user?.password_hash ?? DUMMY_HASH);

  if (!user || !passwordMatches) {
    throw AppError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (!user.is_active) {
    throw AppError.forbidden('This account has been disabled', 'ACCOUNT_DISABLED');
  }

  return { user: publicUser(user), token: signAccessToken(user) };
}

export async function getProfile(userId) {
  const { rows } = await repo.findUserById(pool, userId);
  const user = rows[0];
  if (!user) throw AppError.notFound('User not found', 'USER_NOT_FOUND');

  const { rows: grants } = await repo.listWarehouseGrants(pool, userId);
  return { ...publicUser(user), warehouses: grants };
}

export async function listUsers({ limit, offset }) {
  const { rows, total } = await repo.listUsers(pool, { limit, offset });
  return { rows: rows.map(publicUser), total };
}

/** Admin-only user creation, with optional warehouse grants in one transaction. */
export async function createUser({ actor, input }) {
  const passwordHash = await hashPassword(input.password);

  return withTransaction(async (db) => {
    let user;
    try {
      user = await repo.createUser(db, {
        name: input.name,
        email: input.email,
        passwordHash,
        role: input.role,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw AppError.conflict('An account with this email already exists', 'EMAIL_IN_USE');
      }
      throw error;
    }

    if (input.warehouse_ids?.length) {
      await repo.grantWarehouseAccess(db, {
        userId: user.id,
        warehouseIds: input.warehouse_ids,
        grantedBy: actor.id,
      });
    }

    return { ...publicUser(user), warehouse_ids: input.warehouse_ids ?? [] };
  });
}

/**
 * Updates a user.
 *
 * Refuses to remove the last active administrator. Without this guard a single
 * mis-click demotes the only Admin and the system becomes permanently
 * unadministrable -- there is no in-app recovery path.
 */
export async function updateUser({ actor, userId, patch }) {
  return withTransaction(async (db) => {
    const { rows } = await repo.findUserById(db, userId);
    const existing = rows[0];
    if (!existing) throw AppError.notFound('User not found', 'USER_NOT_FOUND');

    const losesAdminRights =
      existing.role === ROLES.ADMIN &&
      ((patch.role !== undefined && patch.role !== ROLES.ADMIN) || patch.is_active === false);

    if (losesAdminRights) {
      const { rows: others } = await repo.countOtherActiveAdmins(db, userId);
      if (others[0].total === 0) {
        throw AppError.conflict(
          'This is the last active administrator. Promote another user before changing this account.',
          'LAST_ADMIN',
        );
      }
    }

    // Any change to privileges or activation revokes existing sessions.
    const bumpTokenVersion =
      (patch.role !== undefined && patch.role !== existing.role) || patch.is_active === false;

    const { rows: updated } = await repo.updateUser(db, {
      id: userId,
      name: patch.name,
      role: patch.role,
      isActive: patch.is_active,
      bumpTokenVersion,
    });

    return { ...publicUser(updated), sessions_revoked: bumpTokenVersion };
  });
}

/** Grants and/or revokes warehouse access for a user. */
export async function setWarehouseAccess({ actor, userId, grant, revoke }) {
  return withTransaction(async (db) => {
    const { rows } = await repo.findUserById(db, userId);
    if (rows.length === 0) throw AppError.notFound('User not found', 'USER_NOT_FOUND');

    if (grant.length) {
      await repo.grantWarehouseAccess(db, { userId, warehouseIds: grant, grantedBy: actor.id });
    }
    if (revoke.length) {
      await repo.revokeWarehouseAccess(db, { userId, warehouseIds: revoke });
    }

    const { rows: current } = await repo.listWarehouseGrants(db, userId);
    return { user_id: userId, warehouses: current };
  });
}

/** Ends the caller's session by revoking every token issued to them. */
export async function revokeSessions(userId) {
  const { rows } = await repo.bumpTokenVersion(pool, userId);
  return { token_version: rows[0].token_version };
}

/** The roles an administrator is allowed to remove permanently. */
const DELETABLE_ROLES = [ROLES.CLIENT, ROLES.MANAGER, ROLES.STAFF];

/**
 * Permanently deletes a deactivated Client, Manager or Staff account.
 *
 * "Permanently" means the account is gone for good rather than a reversible
 * flag: it vanishes from every read path, its tokens stop working, and its
 * email address is released for reuse. It is implemented as a soft delete
 * because a user row is referenced by orders, the stock ledger and the order
 * status history -- two of those with ON DELETE RESTRICT -- so removing the row
 * would either fail or require destroying financial history, which an ERP must
 * never do as a side effect of deleting an account.
 *
 * The guards run in order and every one of them is re-checked here on the
 * server; hiding the button in the UI is a convenience, not the control.
 */
export async function deleteUser({ actor, userId }) {
  // Checked before anything else: an administrator must not be able to remove
  // their own account, which would revoke the session making the request.
  if (actor.id === userId) {
    throw AppError.forbidden('You cannot permanently delete your own account', 'CANNOT_DELETE_SELF');
  }

  return withTransaction(async (db) => {
    const { rows } = await repo.findUserById(db, userId);
    const existing = rows[0];
    if (!existing) throw AppError.notFound('User not found', 'USER_NOT_FOUND');

    // Administrators are protected even when disabled; removing the only way
    // back into the system is not something a single click should be able to do.
    if (existing.role === ROLES.ADMIN) {
      throw AppError.conflict(
        'Administrator accounts are protected and cannot be permanently deleted.',
        'PROTECTED_ACCOUNT',
      );
    }

    // A backstop rather than a live rule: it now only rejects a role that does
    // not exist yet, and exists so a future addition is non-deletable by default.
    if (!DELETABLE_ROLES.includes(existing.role)) {
      throw AppError.conflict(
        `Only staff, client and manager accounts can be permanently deleted. This account is a ${existing.role}.`,
        'ROLE_NOT_DELETABLE',
      );
    }

    // Deactivation is the deliberate first step: it is reversible, deletion is not.
    if (existing.is_active) {
      throw AppError.conflict(
        'Deactivate this account before deleting it permanently.',
        'USER_ACTIVE',
      );
    }

    const { rows: history } = await repo.countUserHistory(db, userId);
    const { rows: released } = await repo.releaseManagedWarehouses(db, userId);
    await repo.deleteWarehouseGrants(db, userId);

    const { rows: deleted } = await repo.softDeleteUser(db, userId);
    if (deleted.length === 0) throw AppError.notFound('User not found', 'USER_NOT_FOUND');

    return {
      ...publicUser({ ...deleted[0], is_active: false }),
      // Surfaced so the caller can tell the admin what had to be unwound, and
      // what was intentionally kept.
      warehouses_released: released.length,
      history: history[0],
    };
  });
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * The single response for every password-reset request.
 *
 * Exported so the route and the tests cannot drift from it. It is deliberately
 * identical for an unknown address, a disabled account and a real one: the
 * endpoint must not answer the question "does this email have an account?".
 */
export const PASSWORD_RESET_MESSAGE =
  'If an account exists with this email address, you will receive a reset link shortly.';

/**
 * Starts a password reset.
 *
 * Never throws for an ineligible address and never reveals one. Three things
 * keep that promise from leaking through side channels:
 *
 *  - a token is generated and hashed on *both* paths, so the CPU cost is equal;
 *  - the email is dispatched without being awaited, so the response time does
 *    not jump by an SMTP round-trip only when the account is real;
 *  - the reply body is a module constant.
 */
export async function requestPasswordReset({ email }) {
  const { rows } = await repo.findUserByEmail(pool, email);
  const user = rows[0];

  // Eligible means: the row exists (findUserByEmail already excludes deleted
  // accounts) and the account is enabled. A disabled account must not be able
  // to reset its way back in.
  const eligible = Boolean(user?.is_active);

  // Deliberately before the branch: same work, same timing, either way.
  const { raw, hash } = generateResetToken();

  if (!eligible) {
    // Logged at debug with no email address: useful operationally, useless to
    // anyone probing, and it keeps raw addresses out of the log stream.
    logger.debug('password reset requested for ineligible address');
    return { message: PASSWORD_RESET_MESSAGE };
  }

  const expiresAt = new Date(Date.now() + env.resetTokenTtlMs);

  await withTransaction(async (db) => {
    // At most one live link per account: a second request retires the first,
    // so a user is never left guessing which of two emails still works.
    await repo.invalidateOutstandingResetTokens(db, user.id);
    await repo.createPasswordResetToken(db, {
      userId: user.id,
      tokenHash: hash,
      expiresAt,
    });
  });

  sendMailInBackground({
    to: user.email,
    ...passwordResetEmail({
      name: user.name,
      // Built from FRONTEND_URL, never from the request's Host header: a spoofed
      // Host must not be able to redirect the token to another domain.
      resetUrl: buildResetUrl(raw),
      ttlMinutes: env.RESET_TOKEN_TTL_MINUTES,
    }),
  });

  logger.info('password reset link issued', { userId: user.id });
  return { message: PASSWORD_RESET_MESSAGE };
}

/**
 * Answers "is this link still usable?" without spending it.
 *
 * A malformed or unknown token is not an error: it is simply not valid.
 */
export async function validateResetToken({ token }) {
  if (!isWellFormedResetToken(token)) return { valid: false };

  const { rows } = await repo.findPasswordResetToken(pool, hashResetToken(token));
  const record = rows[0];

  // `is_live` is evaluated by Postgres (unused and unexpired); `is_active`
  // stops a link minted before an account was disabled from still working.
  return { valid: Boolean(record?.is_live && record.is_active) };
}

/**
 * Consumes a reset link and sets a new password.
 *
 * Ordering matters:
 *   1. Shape check and a cheap lookup first, so a bogus token cannot force a
 *      bcrypt hash (which would be a cheap CPU-exhaustion primitive).
 *   2. bcrypt runs *outside* the transaction. At cost 12 it takes ~250ms, and
 *      holding a pooled connection plus a row lock for that long is how a reset
 *      endpoint becomes a pool-exhaustion DoS.
 *   3. The transaction re-checks and spends the token atomically, so two
 *      concurrent submissions of the same link cannot both succeed.
 *
 * No session is created: the caller must sign in with the new password.
 */
export async function resetPassword({ token, password }) {
  const invalid = () =>
    AppError.badRequest(
      'This password reset link is invalid or has expired',
      'INVALID_RESET_TOKEN',
    );

  if (!isWellFormedResetToken(token)) throw invalid();

  const tokenHash = hashResetToken(token);

  const { rows: found } = await repo.findPasswordResetToken(pool, tokenHash);
  const candidate = found[0];
  if (!candidate?.is_live || !candidate.is_active) throw invalid();

  const passwordHash = await hashPassword(password);

  const user = await withTransaction(async (db) => {
    // The single-use guarantee. A concurrent request that lost the race gets
    // zero rows here, even though it passed the pre-check above.
    const { rows: spent } = await repo.consumePasswordResetToken(db, tokenHash);
    if (spent.length === 0) throw invalid();

    const userId = spent[0].user_id;

    const { rows: updated } = await repo.setPasswordHash(db, userId, passwordHash);
    if (updated.length === 0) throw invalid();

    // Any other outstanding link for this account dies with the reset.
    await repo.invalidateOutstandingResetTokens(db, userId);

    // No role, is_active or warehouse change happens here: a password reset
    // must not be a back door to privilege or status changes.
    return updated[0];
  });

  // After the commit: an email announcing a change that then rolled back would
  // be a lie, and the token is gone by this point either way.
  sendMailInBackground({ to: user.email, ...passwordChangedEmail({ name: user.name }) });

  logger.info('password reset completed', { userId: user.id });

  // Identity only -- never a token. The client is expected to send the user to
  // the sign-in page, not straight into the console.
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}