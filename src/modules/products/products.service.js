/**
 * Product catalogue.
 *
 * Two audiences, two shapes:
 *   - internal roles use /api/products (includes inactive items, stock totals)
 *   - Clients use /api/catalog, which exposes *only* the aggregate stock level,
 *     never which warehouse holds what. Warehouse-level stock is commercially
 *     sensitive and is not part of a customer's business.
 */
import { query } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';

const STOCK_TOTAL_SUBQUERY = `
  COALESCE((
    SELECT sum(i.quantity)
      FROM inventory i
      JOIN warehouses w ON w.id = i.warehouse_id
     WHERE i.product_id = p.id
       AND w.is_active
       AND w.deleted_at IS NULL
  ), 0)::int AS total_quantity`;

function mapProduct(row) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    unit_price: row.unit_price,
    reorder_level: row.reorder_level,
    is_active: row.is_active,
    total_quantity: row.total_quantity,
    created_at: row.created_at,
  };
}

function buildFilters({ search, category, includeInactive }) {
  const params = [];
  const clauses = ['p.deleted_at IS NULL'];

  if (!includeInactive) clauses.push('p.is_active');
  if (category) {
    params.push(category);
    clauses.push(`p.category = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(p.sku ILIKE $${params.length} OR p.name ILIKE $${params.length})`);
  }

  return { clauses, params };
}

export async function listProducts({ search, category, includeInactive, limit, offset }) {
  const { clauses, params } = buildFilters({ search, category, includeInactive });

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT p.id, p.sku, p.name, p.category, p.unit_price, p.reorder_level, p.is_active, p.created_at,
            ${STOCK_TOTAL_SUBQUERY}
       FROM products p
      WHERE ${clauses.join(' AND ')}
      ORDER BY p.name ASC, p.id ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const countParams = params.slice(0, params.length - 2);
  const { rows: countRows } = await query(
    `SELECT count(*)::int AS total FROM products p WHERE ${clauses.join(' AND ')}`,
    countParams,
  );

  return { rows: rows.map(mapProduct), total: countRows[0].total };
}

/** Client-facing catalogue: active products, aggregate availability only. */
export async function getCatalog({ search, category, limit, offset }) {
  const { clauses, params } = buildFilters({ search, category, includeInactive: false });

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT p.id, p.sku, p.name, p.category, p.unit_price, p.reorder_level, p.is_active, p.created_at,
            ${STOCK_TOTAL_SUBQUERY}
       FROM products p
      WHERE ${clauses.join(' AND ')}
      ORDER BY p.name ASC, p.id ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const countParams = params.slice(0, params.length - 2);
  const { rows: countRows } = await query(
    `SELECT count(*)::int AS total FROM products p WHERE ${clauses.join(' AND ')}`,
    countParams,
  );

  return {
    rows: rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      category: row.category,
      unit_price: row.unit_price,
      // Availability only -- not the per-warehouse breakdown.
      available: row.total_quantity,
      in_stock: row.total_quantity > 0,
    })),
    total: countRows[0].total,
  };
}

export async function getProduct(productId) {
  const { rows } = await query(
    `SELECT p.id, p.sku, p.name, p.category, p.unit_price, p.reorder_level, p.is_active, p.created_at,
            ${STOCK_TOTAL_SUBQUERY}
       FROM products p
      WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [productId],
  );

  if (rows.length === 0) throw AppError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  return mapProduct(rows[0]);
}

export async function createProduct({ input }) {
  try {
    const { rows } = await query(
      `INSERT INTO products (sku, name, category, unit_price, reorder_level)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, sku, name, category, unit_price, reorder_level, is_active, created_at`,
      [input.sku, input.name, input.category ?? null, input.unit_price, input.reorder_level],
    );
    return { ...mapProduct(rows[0]), total_quantity: 0 };
  } catch (error) {
    // SKUs are unique case-insensitively, so 'abc-1' collides with 'ABC-1'.
    if (error.code === '23505') {
      throw AppError.conflict('A product with this SKU already exists', 'SKU_IN_USE', {
        sku: input.sku,
      });
    }
    throw error;
  }
}

export async function updateProduct({ productId, patch }) {
  try {
    const { rows } = await query(
      `UPDATE products
          SET name = COALESCE($2, name),
              category = CASE WHEN $3::boolean THEN $4 ELSE category END,
              unit_price = COALESCE($5, unit_price),
              reorder_level = COALESCE($6, reorder_level),
              is_active = COALESCE($7, is_active)
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, sku, name, category, unit_price, reorder_level, is_active, created_at`,
      [
        productId,
        patch.name ?? null,
        Object.prototype.hasOwnProperty.call(patch, 'category'),
        patch.category ?? null,
        patch.unit_price ?? null,
        patch.reorder_level ?? null,
        patch.is_active ?? null,
      ],
    );

    if (rows.length === 0) throw AppError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
    return getProduct(productId);
  } catch (error) {
    if (error.code === '23505') {
      throw AppError.conflict('A product with this SKU already exists', 'SKU_IN_USE');
    }
    throw error;
  }
}

/** Soft delete: order history must keep pointing at a real row. */
export async function archiveProduct({ productId }) {
  const { rows } = await query(
    `UPDATE products
        SET is_active = false, deleted_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, sku, name`,
    [productId],
  );

  if (rows.length === 0) throw AppError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  return rows[0];
}

export { bulkImportProducts } from './products.importer.js';