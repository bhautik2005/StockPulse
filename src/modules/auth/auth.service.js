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
import { ROLES } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../../lib/password.js';
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