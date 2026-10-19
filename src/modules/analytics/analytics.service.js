/**
 * Dashboard analytics.
 *
 * Three rules are applied consistently here, because reporting is where sloppy
 * data handling shows up first:
 *
 *  1. Money is summed in SQL as NUMERIC and returned as a string. Nothing is
 *     ever added up in JavaScript.
 *  2. Cancelled orders are excluded from revenue by an explicit filter -- the
 *     definition of "revenue" is stated in the query, not implied.
 *  3. Day buckets are computed in an explicit timezone (UTC) and gap days are
 *     filled with zeros, so a chart cannot imply activity on a day with none.
 */
import { pool, query } from '../../db/pool.js';
import { warehouseScopeClause } from '../../lib/warehouseScope.js';

/**
 * Visibility predicate for orders.
 *
 * For a warehouse-scoped user this is an EXISTS over order_items, so a Manager
 * sees an order only if it contains at least one line they are responsible for.
 */
function orderVisibilityClause(scope, params) {
  if (scope?.all) return 'TRUE';
  if (!scope?.ids?.length) return 'FALSE';
  params.push(scope.ids);
  return `EXISTS (SELECT 1 FROM order_items vis
                   WHERE vis.order_id = o.id
                     AND vis.warehouse_id = ANY($${params.length}::int[]))`;
}

/**
 * Headline metrics.
 *
 * A scoped user's revenue counts only the value of lines in their own
 * warehouses -- not the whole order. A Manager should not be credited with a
 * shipment that was fulfilled elsewhere.
 */
export async function summary({ scope }) {
  const orderParams = [];
  const visibility = orderVisibilityClause(scope, orderParams);

  const ordersPromise = query(
    `SELECT count(*)::int AS total_orders,
            count(*) FILTER (WHERE o.status = 'Pending')::int AS pending_orders,
            count(*) FILTER (WHERE o.status IN ('Pending', 'Processing', 'Partially Shipped', 'Shipped'))::int AS active_orders,
            count(*) FILTER (WHERE o.status = 'Delivered')::int AS delivered_orders,
            count(*) FILTER (WHERE o.status = 'Cancelled')::int AS cancelled_orders
       FROM orders o
      WHERE ${visibility}`,
    orderParams,
  );

  const revenuePromise = scope.all
    ? query(
        `SELECT COALESCE(sum(total_amount) FILTER (WHERE status <> 'Cancelled'), 0)::numeric(14,2) AS total_revenue,
                COALESCE(sum(total_amount) FILTER (WHERE status = 'Delivered'), 0)::numeric(14,2) AS delivered_revenue
           FROM orders`,
      )
    : query(
        `SELECT COALESCE(sum(oi.line_total) FILTER (WHERE o.status <> 'Cancelled'), 0)::numeric(14,2) AS total_revenue,
                COALESCE(sum(oi.line_total) FILTER (WHERE o.status = 'Delivered'), 0)::numeric(14,2) AS delivered_revenue
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE oi.warehouse_id = ANY($1::int[])`,
        [scope.ids],
      );

  const lowStockParams = [];
  const lowStockClause = warehouseScopeClause(scope, 'warehouse_id', lowStockParams);

  const lowStockPromise = query(
    `SELECT count(*)::int AS low_stock_rows,
            count(DISTINCT product_id)::int AS low_stock_products
       FROM low_stock
      WHERE ${lowStockClause}`,
    lowStockParams,
  );

  const stockParams = [];
  const stockClause = warehouseScopeClause(scope, 'i.warehouse_id', stockParams);

  const stockPromise = query(
    `SELECT COALESCE(sum(i.quantity), 0)::bigint AS units_on_hand,
            COALESCE(sum(i.quantity * p.unit_price), 0)::numeric(14,2) AS stock_value
       FROM inventory i
       JOIN products p ON p.id = i.product_id
      WHERE ${stockClause}
        AND p.is_active = true
        AND p.deleted_at IS NULL`,
    stockParams,
  );

  const [orders, revenue, lowStock, stock] = await Promise.all([
    ordersPromise,
    revenuePromise,
    lowStockPromise,
    stockPromise,
  ]);

  return {
    scope: scope.all ? 'all_warehouses' : 'assigned_warehouses',
    revenue: {
      total: revenue.rows[0].total_revenue,
      delivered: revenue.rows[0].delivered_revenue,
      currency: 'USD',
      definition: 'All non-cancelled orders',
    },
    orders: orders.rows[0],
    low_stock: lowStock.rows[0],
    inventory: {
      units_on_hand: stock.rows[0].units_on_hand,
      stock_value: stock.rows[0].stock_value,
    },
  };
}

/**
 * Daily revenue for the last `days` days.
 *
 * Gap days are materialised with zeros: a line chart that simply omits empty
 * days draws a straight line between two distant points and implies revenue
 * that never happened.
 */
export async function salesTrend({ scope, days = 30 }) {
  const params = [];
  const visibility = orderVisibilityClause(scope, params);
  params.push(days);
  const dayParam = `$${params.length}`;

  const { rows } = await query(
    `SELECT to_char(date_trunc('day', o.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            COALESCE(sum(o.total_amount), 0)::numeric(14,2) AS revenue,
            count(DISTINCT o.id)::int AS orders
       FROM orders o
      WHERE o.status <> 'Cancelled'
        AND o.created_at >= (now() AT TIME ZONE 'UTC') - (${dayParam}::int * interval '1 day')
        AND ${visibility}
      GROUP BY 1
      ORDER BY 1`,
    params,
  );

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series = [];
  const today = new Date();

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    const found = byDay.get(key);

    series.push({
      day: key,
      revenue: found ? found.revenue : '0.00',
      orders: found ? found.orders : 0,
    });
  }

  return series;
}

/** Best-selling products by revenue. Falls back to the snapshot when a product was archived. */
export async function topProducts({ scope, limit = 10 }) {
  const params = [];
  const visibility = orderVisibilityClause(scope, params);
  params.push(limit);

  const { rows } = await query(
    `SELECT COALESCE(p.id, 0) AS product_id,
            COALESCE(p.sku, oi.product_sku) AS sku,
            COALESCE(p.name, oi.product_name) AS product_name,
            sum(oi.quantity)::int AS units_sold,
            sum(oi.line_total)::numeric(14,2) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN products p ON p.id = oi.product_id
      WHERE o.status <> 'Cancelled'
        AND ${visibility}
      GROUP BY COALESCE(p.id, 0), COALESCE(p.sku, oi.product_sku), COALESCE(p.name, oi.product_name)
      ORDER BY revenue DESC, sku ASC
      LIMIT $${params.length}`,
    params,
  );

  return rows;
}

/** Per-warehouse stock position, including how many lines are below threshold. */
export async function byWarehouse({ scope }) {
  const params = [];
  const clause = warehouseScopeClause(scope, 'w.id', params);

  const { rows } = await query(
    `SELECT w.id, w.code, w.name, w.location, w.is_active,
            COALESCE(sum(i.quantity), 0)::int AS units_on_hand,
            COALESCE(sum(i.quantity * p.unit_price), 0)::numeric(14,2) AS stock_value,
            count(*) FILTER (
              WHERE i.id IS NOT NULL
                AND i.quantity <= COALESCE(i.reorder_level, p.reorder_level)
            )::int AS low_stock_count
       FROM warehouses w
       LEFT JOIN inventory i ON i.warehouse_id = w.id
       LEFT JOIN products  p ON p.id = i.product_id AND p.deleted_at IS NULL AND p.is_active = true
      WHERE w.deleted_at IS NULL AND ${clause}
      GROUP BY w.id
      ORDER BY w.id`,
    params,
  );

  return rows;
}