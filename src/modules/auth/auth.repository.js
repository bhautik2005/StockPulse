/**
 * User / authentication persistence.
 */
export function findUserByEmail(db, email) {
  return db.query(
    `SELECT id, name, email, password_hash, role, is_active, token_version
       FROM users
      WHERE lower(email) = lower($1)
        AND deleted_at IS NULL`,
    [email],
  );
}

export function findUserById(db, id) {
  return db.query(
    `SELECT id, name, email, role, is_active, token_version, created_at
       FROM users
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
}

export async function createUser(db, { name, email, passwordHash, role }) {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, role, is_active, created_at`,
    [name, email, passwordHash, role],
  );
  return rows[0];
}

export async function listUsers(db, { limit, offset }) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
            COALESCE(
              (SELECT array_agg(uw.warehouse_id ORDER BY uw.warehouse_id)
                 FROM user_warehouses uw WHERE uw.user_id = u.id),
              '{}'
            ) AS warehouse_ids
       FROM users u
      WHERE u.deleted_at IS NULL
      ORDER BY u.id
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const { rows: countRows } = await db.query(
    'SELECT count(*)::int AS total FROM users WHERE deleted_at IS NULL',
  );
  return { rows, total: countRows[0].total };
}

/**
 * Counts *other* active admins. Used to refuse the last remaining admin's
 * self-demotion, which would otherwise lock every human out of the system
 * permanently -- there is no way back in without direct database access.
 */
export function countOtherActiveAdmins(db, excludeUserId) {
  return db.query(
    `SELECT count(*)::int AS total
       FROM users
      WHERE role = 'Admin'
        AND is_active
        AND deleted_at IS NULL
        AND id <> $1`,
    [excludeUserId],
  );
}

export function updateUser(db, { id, name, role, isActive, bumpTokenVersion }) {
  return db.query(
    `UPDATE users
        SET name = COALESCE($2, name),
            role = COALESCE($3, role),
            is_active = COALESCE($4, is_active),
            token_version = token_version + CASE WHEN $5::boolean THEN 1 ELSE 0 END
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, name, email, role, is_active, token_version`,
    [id, name ?? null, role ?? null, isActive ?? null, bumpTokenVersion === true],
  );
}

/** Revokes every token already issued to this user. */
export function bumpTokenVersion(db, id) {
  return db.query(
    `UPDATE users SET token_version = token_version + 1
      WHERE id = $1 RETURNING token_version`,
    [id],
  );
}

export function grantWarehouseAccess(db, { userId, warehouseIds, grantedBy }) {
  if (warehouseIds.length === 0) return Promise.resolve({ rowCount: 0 });
  return db.query(
    `INSERT INTO user_warehouses (user_id, warehouse_id, granted_by)
     SELECT $1, w, $3 FROM unnest($2::int[]) AS w
     ON CONFLICT (user_id, warehouse_id) DO NOTHING`,
    [userId, warehouseIds, grantedBy ?? null],
  );
}

export function revokeWarehouseAccess(db, { userId, warehouseIds }) {
  return db.query(
    `DELETE FROM user_warehouses
      WHERE user_id = $1 AND warehouse_id = ANY($2::int[])`,
    [userId, warehouseIds],
  );
}

export function listWarehouseGrants(db, userId) {
  return db.query(
    `SELECT w.id, w.code, w.name
       FROM user_warehouses uw
       JOIN warehouses w ON w.id = uw.warehouse_id
      WHERE uw.user_id = $1 AND w.deleted_at IS NULL
      ORDER BY w.id`,
    [userId],
  );
}