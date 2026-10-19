import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Eye, Plus, ShoppingCart } from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { useApiResource } from '../hooks/useApiResource.js';
import { ORDER_STATUS, ROLES } from '../lib/constants.js';
import { formatMoney, formatRelative } from '../lib/format.js';
import { ordersApi, warehousesApi } from '../services/endpoints.js';
import { OrderBuilderDialog } from '../components/orders/OrderBuilderDialog.jsx';
import { OrderDetailDialog } from '../components/orders/OrderDetailDialog.jsx';
import { StatusBadge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card, CardToolbar } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, TableSkeleton } from '../components/ui/Feedback.jsx';
import { Input } from '../components/ui/Input.jsx';
import { Pagination } from '../components/ui/Pagination.jsx';
import { Table, TBody, TD, TDNumeric, TH, THead, TR } from '../components/ui/Table.jsx';
import { Tabs } from '../components/ui/Tabs.jsx';

/** Roles the API accepts an order from. A Manager reviews orders, never raises one. */
const CAN_CREATE = [ROLES.CLIENT, ROLES.STAFF, ROLES.ADMIN];

export function Orders() {
  const { user, isInternal } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page') ?? 1);
  const status = searchParams.get('status') ?? '';
  const warehouseId = searchParams.get('warehouse_id') ?? '';
  const from = searchParams.get('from') ?? '';
  const to = searchParams.get('to') ?? '';

  const [detailId, setDetailId] = useState(null);
  const [builderOpen, setBuilderOpen] = useState(searchParams.get('new') === '1');

  const warehouses = useApiResource(() => warehousesApi.list({ limit: 100 }), [], { skip: !isInternal });

  const orders = useApiResource(
    () =>
      ordersApi.list({
        page,
        limit: 20,
        status: status || undefined,
        warehouse_id: warehouseId || undefined,
        // The API coerces these to timestamps; an empty string is omitted rather
        // than sent as an invalid date.
        from: from || undefined,
        to: to || undefined,
      }),
    [page, status, warehouseId, from, to],
  );

  function updateParams(changes) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '' || value === false) next.delete(key);
        else next.set(key, String(value));
      }
      if (!('page' in changes)) next.delete('page');
      next.delete('new');
      next.delete('product_id');
      return next;
    });
  }

  function closeBuilder() {
    setBuilderOpen(false);
    if (searchParams.get('new') || searchParams.get('product_id')) {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('new');
          next.delete('product_id');
          return next;
        },
        { replace: true },
      );
    }
  }

  const rows = orders.data ?? [];
  const meta = orders.meta ?? { page, limit: 20, total: 0 };
  const canCreate = CAN_CREATE.includes(user?.role);
  const hasFilters = Boolean(status || warehouseId || from || to);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">
            {user?.role === ROLES.CLIENT ? 'My orders' : 'Orders'}
          </h2>
          <p className="text-xs text-muted-foreground">
            {meta.total} order{meta.total === 1 ? '' : 's'}
            {user?.role === ROLES.CLIENT ? ' placed by your account' : ' in your scope'}.
          </p>
        </div>

        {canCreate ? (
          <Button onClick={() => setBuilderOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New order
          </Button>
        ) : null}
      </div>

      <Card>
        <CardToolbar className="flex-wrap">
          <Tabs
            value={status}
            onValueChange={(value) => updateParams({ status: value === 'all' ? null : value })}
            tabs={[{ value: '', label: 'All' }, ...ORDER_STATUS.map((value) => ({ value, label: value }))]}
          />
        </CardToolbar>

        <CardToolbar className="flex-wrap border-t border-border">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              From
              <Input
                type="date"
                className="w-36"
                value={from}
                onChange={(event) => updateParams({ from: event.target.value })}
              />
            </label>
            <label className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              To
              <Input
                type="date"
                className="w-36"
                value={to}
                onChange={(event) => updateParams({ to: event.target.value })}
              />
            </label>

            {isInternal ? (
              <select
                className="focus-ring h-8 rounded-md border border-input bg-background px-2 text-xs"
                value={warehouseId}
                onChange={(event) => updateParams({ warehouse_id: event.target.value })}
                aria-label="Filter by warehouse"
              >
                <option value="">All warehouses</option>
                {(warehouses.data ?? []).map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.code} — {warehouse.name}
                  </option>
                ))}
              </select>
            ) : null}

            {hasFilters ? (
              <Button variant="ghost" size="sm" onClick={() => setSearchParams(new URLSearchParams())}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </CardToolbar>

        {orders.error ? (
          <ErrorState error={orders.error} onRetry={orders.reload} />
        ) : orders.loading ? (
          <TableSkeleton rows={8} columns={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ShoppingCart}
            title={hasFilters ? 'No orders match these filters' : 'No orders yet'}
            description={
              hasFilters
                ? 'Widen the date range or clear the status filter.'
                : canCreate
                  ? 'Place the first order to see it here.'
                  : 'Orders raised by clients will appear here.'
            }
            action={canCreate && !hasFilters ? <Button onClick={() => setBuilderOpen(true)}>New order</Button> : null}
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Order</TH>
                  <TH>Client</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Lines</TH>
                  <TH className="text-right">Total</TH>
                  <TH className="text-right">Placed</TH>
                  <TH className="text-right">View</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((order) => (
                  <TR key={order.id} className="cursor-pointer" onClick={() => setDetailId(order.id)}>
                    <TD className="font-mono text-xs">{order.order_number}</TD>
                    <TD className="max-w-[14rem] truncate text-xs">{order.client_name}</TD>
                    <TD>
                      <StatusBadge status={order.status} />
                    </TD>
                    <TDNumeric className="text-xs">{order.line_count}</TDNumeric>
                    <TDNumeric className="text-xs font-medium">
                      {formatMoney(order.total_amount, order.currency)}
                    </TDNumeric>
                    <TD className="text-right text-2xs text-muted-foreground">
                      {formatRelative(order.created_at)}
                    </TD>
                    <TD className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDetailId(order.id);
                        }}
                      >
                        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                        Details
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>

            <Pagination
              page={meta.page ?? page}
              limit={meta.limit ?? 20}
              total={meta.total ?? 0}
              onPageChange={(next) => updateParams({ page: next })}
            />
          </>
        )}
      </Card>

      <OrderBuilderDialog
        open={builderOpen}
        onClose={closeBuilder}
        prefillProductId={searchParams.get('product_id')}
        onCreated={(order) => {
          orders.reload();
          setDetailId(order.id);
        }}
      />

      <OrderDetailDialog
        orderId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={orders.reload}
      />
    </div>
  );
}