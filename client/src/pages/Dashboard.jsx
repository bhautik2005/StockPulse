import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, ArrowRight, DollarSign, Package, ShoppingCart, Warehouse } from 'lucide-react';

import { useApiResource } from '../hooks/useApiResource.js';
import { formatMoney, formatNumber, formatRelative, shortDay } from '../lib/format.js';
import { analyticsApi, ordersApi } from '../services/endpoints.js';
import { StatCard } from '../components/StatCard.jsx';
import { StatusBadge } from '../components/ui/Badge.jsx';
import { Card, CardContent, CardToolbar, CardTitle } from '../components/ui/Card.jsx';
import { ErrorState, Skeleton, TableSkeleton } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TDNumeric, TH, THead, TR } from '../components/ui/Table.jsx';
import { Tabs } from '../components/ui/Tabs.jsx';

/**
 * Chart palette. Plain HSL rather than theme tokens: Recharts paints SVG fills
 * and cannot resolve `hsl(var(--primary))` itself, and these six read correctly
 * on both the light and the dark surface.
 */
const CHART_COLORS = [
  'hsl(199 89% 48%)',
  'hsl(262 83% 62%)',
  'hsl(142 65% 45%)',
  'hsl(32 95% 55%)',
  'hsl(0 72% 58%)',
  'hsl(215 20% 55%)',
];

const RANGES = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
];

const compactMoney = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

const tooltipStyle = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  fontSize: 12,
  color: 'hsl(var(--popover-foreground))',
  padding: '6px 10px',
};

export function Dashboard() {
  const [days, setDays] = useState(30);

  const summary = useApiResource(() => analyticsApi.summary(), []);
  const trend = useApiResource(() => analyticsApi.salesTrend(days), [days]);
  const byWarehouse = useApiResource(() => analyticsApi.byWarehouse(), []);
  const topProducts = useApiResource(() => analyticsApi.topProducts(5), []);
  const recentOrders = useApiResource(() => ordersApi.list({ page: 1, limit: 5 }), []);

  // Money arrives as an exact decimal string. Parsing it here is for the axis
  // and the plot only -- no total shown to a user is ever computed in JS.
  const trendData = (trend.data ?? []).map((point) => ({ ...point, value: Number(point.revenue) }));

  const warehouses = (byWarehouse.data ?? []).map((row) => ({
    ...row,
    value: Number(row.stock_value),
  }));
  const totalStockValue = warehouses.reduce((sum, row) => sum + row.value, 0);

  if (summary.error) {
    return (
      <Card>
        <ErrorState error={summary.error} onRetry={summary.reload} />
      </Card>
    );
  }

  const revenue = summary.data?.revenue;
  const orders = summary.data?.orders;
  const lowStock = summary.data?.low_stock;
  const inventory = summary.data?.inventory;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Operational summary</h2>
          <p className="text-xs text-muted-foreground">
            {summary.data?.scope === 'all_warehouses'
              ? 'Across every warehouse.'
              : 'Limited to the warehouses assigned to you.'}
          </p>
        </div>
        <p className="text-2xs text-muted-foreground">
          Revenue counts all non-cancelled orders.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total revenue"
          value={formatMoney(revenue?.total, revenue?.currency)}
          hint={summary.data?.scope === 'all_warehouses' ? 'all warehouses' : 'assigned warehouses'}
          icon={DollarSign}
          tone="primary"
          loading={summary.loading}
        />
        <StatCard
          label="Active warehouses"
          value={formatNumber(warehouses.filter((row) => row.is_active).length)}
          hint={`${formatMoney(inventory?.stock_value, revenue?.currency)} on hand`}
          icon={Warehouse}
          loading={byWarehouse.loading}
        />
        <StatCard
          label="Low-stock alerts"
          value={formatNumber(lowStock?.low_stock_rows)}
          hint={
            lowStock?.low_stock_rows
              ? 'at or below reorder level'
              : 'nothing below threshold'
          }
          icon={AlertTriangle}
          tone={lowStock?.low_stock_rows ? 'warning' : 'success'}
          loading={summary.loading}
        />
        <StatCard
          label="Pending orders"
          value={formatNumber(orders?.pending_orders)}
          hint={`${formatNumber(orders?.total_orders)} orders total`}
          icon={ShoppingCart}
          loading={summary.loading}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardToolbar>
            <div>
              <CardTitle>Sales revenue</CardTitle>
              <p className="text-2xs text-muted-foreground">
                Daily, with empty days shown as zero
              </p>
            </div>
            <Tabs value={days} onValueChange={setDays} tabs={RANGES} />
          </CardToolbar>
          <CardContent className="pt-4">
            {trend.error ? (
              <ErrorState error={trend.error} onRetry={trend.reload} />
            ) : trend.loading ? (
              <Skeleton className="h-[220px] w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={trendData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_COLORS[0]} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={CHART_COLORS[0]} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="day"
                    tickFormatter={shortDay}
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    tickFormatter={(value) => compactMoney.format(value)}
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false}
                    axisLine={false}
                    width={52}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={(label) => shortDay(label)}
                    formatter={(value, name) =>
                      name === 'value'
                        ? [formatMoney(value, revenue?.currency), 'Revenue']
                        : [value, name]
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={CHART_COLORS[0]}
                    strokeWidth={2}
                    fill="url(#revenueFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardToolbar>
            <div>
              <CardTitle>Stock value by warehouse</CardTitle>
              <p className="text-2xs text-muted-foreground">Share of inventory on hand</p>
            </div>
          </CardToolbar>
          <CardContent className="pt-4">
            {byWarehouse.error ? (
              <ErrorState error={byWarehouse.error} onRetry={byWarehouse.reload} />
            ) : byWarehouse.loading ? (
              <Skeleton className="h-[220px] w-full" />
            ) : warehouses.length === 0 ? (
              <p className="py-16 text-center text-xs text-muted-foreground">No warehouses yet.</p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={warehouses}
                      dataKey="value"
                      nameKey="code"
                      innerRadius={52}
                      outerRadius={80}
                      paddingAngle={2}
                      strokeWidth={0}
                    >
                      {warehouses.map((entry, index) => (
                        <Cell key={entry.id} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value, name, item) => [
                        `${formatMoney(value, revenue?.currency)} · ${formatNumber(item?.payload?.units_on_hand)} units`,
                        item?.payload?.name ?? name,
                      ]}
                    />
                  </PieChart>
                </ResponsiveContainer>

                <ul className="mt-3 flex flex-col gap-2">
                  {warehouses.map((row, index) => (
                    <li key={row.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: CHART_COLORS[index % CHART_COLORS.length] }}
                          aria-hidden="true"
                        />
                        <span className="truncate">{row.name}</span>
                        <span className="shrink-0 font-mono text-2xs text-muted-foreground">{row.code}</span>
                      </span>
                      <span className="tabular shrink-0 text-muted-foreground">
                        {totalStockValue > 0 ? Math.round((row.value / totalStockValue) * 100) : 0}%
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardToolbar>
            <CardTitle>Recent orders</CardTitle>
            <Link
              to="/orders"
              className="focus-ring flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              View all
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </CardToolbar>

          {recentOrders.error ? (
            <ErrorState error={recentOrders.error} onRetry={recentOrders.reload} />
          ) : recentOrders.loading ? (
            <TableSkeleton rows={5} columns={4} />
          ) : (recentOrders.data ?? []).length === 0 ? (
            <p className="px-4 py-10 text-center text-xs text-muted-foreground">No orders yet.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Order</TH>
                  <TH>Client</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Total</TH>
                  <TH className="text-right">Placed</TH>
                </TR>
              </THead>
              <TBody>
                {recentOrders.data.map((order) => (
                  <TR key={order.id}>
                    <TD className="font-mono text-xs">{order.order_number}</TD>
                    <TD className="max-w-[12rem] truncate text-xs">{order.client_name}</TD>
                    <TD>
                      <StatusBadge status={order.status} />
                    </TD>
                    <TDNumeric className="text-xs">
                      {formatMoney(order.total_amount, order.currency)}
                    </TDNumeric>
                    <TD className="text-right text-2xs text-muted-foreground">
                      {formatRelative(order.created_at)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardToolbar>
            <CardTitle>Top products</CardTitle>
            <Package className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          </CardToolbar>

          {topProducts.error ? (
            <ErrorState error={topProducts.error} onRetry={topProducts.reload} />
          ) : topProducts.loading ? (
            <div className="flex flex-col gap-3 p-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-8 w-full" />
              ))}
            </div>
          ) : (topProducts.data ?? []).length === 0 ? (
            <p className="px-4 py-10 text-center text-xs text-muted-foreground">
              Nothing sold in this period.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {topProducts.data.map((product) => (
                <li key={product.product_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{product.product_name}</p>
                    <p className="font-mono text-2xs text-muted-foreground">{product.sku}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tabular text-xs">{formatMoney(product.revenue, revenue?.currency)}</p>
                    <p className="tabular text-2xs text-muted-foreground">
                      {formatNumber(product.units_sold)} units
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}