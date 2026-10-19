import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Filter, PackageSearch, Search, SlidersHorizontal, X } from 'lucide-react';

import { useApiResource, useDebouncedValue } from '../hooks/useApiResource.js';
import { describeError } from '../lib/errors.js';
import { formatAmount, formatMoney, formatNumber } from '../lib/format.js';
import { inventoryApi, warehousesApi } from '../services/endpoints.js';
import { Badge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card, CardToolbar } from '../components/ui/Card.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { EmptyState, ErrorState, TableSkeleton } from '../components/ui/Feedback.jsx';
import { Field, Input, Textarea } from '../components/ui/Input.jsx';
import { Pagination } from '../components/ui/Pagination.jsx';
import { Table, TBody, TD, TDNumeric, TH, THead, TR } from '../components/ui/Table.jsx';
import { useToast } from '../components/ui/Toast.jsx';

/**
 * Inventory is filtered through the URL.
 *
 * That is what makes the warehouse card's "View inventory" link and the
 * header's low-stock badge work: they navigate with a query string, and the
 * page state is whatever the URL says. A reload or a shared link reproduces the
 * exact same view.
 */
export function Inventory() {
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();

  const page = Number(searchParams.get('page') ?? 1);
  const warehouseId = searchParams.get('warehouse_id') ?? '';
  const productId = searchParams.get('product_id') ?? '';
  const lowStockOnly = searchParams.get('low_stock') === 'true';
  const searchInUrl = searchParams.get('search') ?? '';

  const [search, setSearch] = useState(searchInUrl);
  const [adjusting, setAdjusting] = useState(null);
  const [adjustForm, setAdjustForm] = useState({ delta: '', note: '' });
  const [adjustError, setAdjustError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const debouncedSearch = useDebouncedValue(search, 350);

  const warehouses = useApiResource(() => warehousesApi.list({ limit: 100 }), []);

  const inventory = useApiResource(
    () =>
      inventoryApi.list({
        page,
        limit: 20,
        warehouse_id: warehouseId || undefined,
        product_id: productId || undefined,
        low_stock: lowStockOnly ? 'true' : undefined,
        search: debouncedSearch || undefined,
      }),
    [page, warehouseId, productId, lowStockOnly, debouncedSearch],
  );

  // Mirror the debounced search into the URL, resetting to page 1 so a new term
  // does not land the user on a page that no longer exists.
  useEffect(() => {
    if (debouncedSearch === searchInUrl) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (debouncedSearch) next.set('search', debouncedSearch);
        else next.delete('search');
        next.delete('page');
        return next;
      },
      { replace: true },
    );
  }, [debouncedSearch, searchInUrl, setSearchParams]);

  function updateParams(changes) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '' || value === false) next.delete(key);
        else next.set(key, String(value));
      }
      if (!('page' in changes)) next.delete('page');
      return next;
    });
  }

  const hasFilters = Boolean(warehouseId || productId || lowStockOnly || searchInUrl);
  const rows = inventory.data ?? [];
  const meta = inventory.meta ?? { page, limit: 20, total: 0 };
  const selectedWarehouse = (warehouses.data ?? []).find((row) => String(row.id) === warehouseId);

  function openAdjust(row) {
    setAdjustForm({ delta: '', note: '' });
    setAdjustError(null);
    setAdjusting(row);
  }

  async function handleAdjust(event) {
    event.preventDefault();
    const delta = Number(adjustForm.delta);

    if (!Number.isInteger(delta) || delta === 0) {
      setAdjustError({ message: 'Enter a whole number other than zero.' });
      return;
    }

    setSubmitting(true);
    setAdjustError(null);
    try {
      await inventoryApi.adjust({
        product_id: adjusting.product.id,
        warehouse_id: adjusting.warehouse.id,
        delta,
        note: adjustForm.note.trim() || undefined,
      });
      toast.success(
        'Stock adjusted',
        `${adjusting.product.sku} at ${adjusting.warehouse.code}: ${delta > 0 ? '+' : ''}${delta} units.`,
      );
      setAdjusting(null);
      inventory.reload();
    } catch (caught) {
      setAdjustError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  const projected = adjusting ? adjusting.quantity + (Number(adjustForm.delta) || 0) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Inventory</h2>
          <p className="text-xs text-muted-foreground">
            {selectedWarehouse ? `${selectedWarehouse.name} · ` : 'All warehouses in your scope · '}
            {formatNumber(meta.total)} stock line{meta.total === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      <Card>
        <CardToolbar className="flex-wrap">
          <div className="relative min-w-[14rem] flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              className="pl-8"
              placeholder="Search by SKU or product name"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search inventory"
            />
          </div>

          <select
            className="focus-ring h-8 rounded-md border border-input bg-background px-2 text-xs"
            value={warehouseId}
            onChange={(event) => updateParams({ warehouse_id: event.target.value })}
            aria-label="Filter by warehouse"
          >
            <option value="">All warehouses</option>
            {(warehouses.data ?? []).map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name} ({warehouse.code})
              </option>
            ))}
          </select>

          <Button
            variant={lowStockOnly ? 'default' : 'outline'}
            size="sm"
            onClick={() => updateParams({ low_stock: lowStockOnly ? null : 'true' })}
            aria-pressed={lowStockOnly}
          >
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            Low stock only
          </Button>

          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch('');
                setSearchParams(new URLSearchParams(), { replace: true });
              }}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Clear
            </Button>
          ) : null}
        </CardToolbar>

        {inventory.error ? (
          <ErrorState error={inventory.error} onRetry={inventory.reload} />
        ) : inventory.loading ? (
          <TableSkeleton rows={8} columns={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={hasFilters ? Filter : PackageSearch}
            title={hasFilters ? 'No stock matches these filters' : 'No stock recorded yet'}
            description={
              hasFilters
                ? 'Try a different warehouse, or clear the filters.'
                : 'Stock appears here once a product has been received into a warehouse.'
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>Warehouse</TH>
                  <TH className="text-right">On hand</TH>
                  <TH className="text-right">Reorder level</TH>
                  <TH className="text-right">Unit price</TH>
                  <TH className="text-right">Stock value</TH>
                  <TH className="text-right">Adjust</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={`${row.product.id}-${row.warehouse.id}`}>
                    <TD>
                      <div className="flex flex-col">
                        <span className="text-xs font-medium">{row.product.name}</span>
                        <span className="font-mono text-2xs text-muted-foreground">{row.product.sku}</span>
                      </div>
                    </TD>
                    <TD>
                      <div className="flex flex-col">
                        <span className="text-xs">{row.warehouse.name}</span>
                        <span className="font-mono text-2xs text-muted-foreground">{row.warehouse.code}</span>
                      </div>
                    </TD>
                    <TDNumeric>
                      <span className={row.is_low_stock ? 'font-semibold text-warning' : ''}>
                        {formatAmount(row.quantity)}
                      </span>
                      {row.is_low_stock ? (
                        <Badge tone="warning" className="ml-2 align-middle">
                          Low
                        </Badge>
                      ) : null}
                    </TDNumeric>
                    <TDNumeric className="text-xs text-muted-foreground">
                      {formatAmount(row.reorder_level)}
                    </TDNumeric>
                    <TDNumeric className="text-xs">{formatMoney(row.unit_price, row.currency)}</TDNumeric>
                    <TDNumeric className="text-xs">{formatMoney(row.stock_value, row.currency)}</TDNumeric>
                    <TD className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => openAdjust(row)}>
                        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                        Adjust
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

      <Dialog
        open={Boolean(adjusting)}
        onClose={() => setAdjusting(null)}
        title="Adjust stock"
        description={
          adjusting
            ? `${adjusting.product.name} at ${adjusting.warehouse.name}`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setAdjusting(null)}>
              Cancel
            </Button>
            <Button type="submit" form="adjust-form" loading={submitting}>
              Apply adjustment
            </Button>
          </>
        }
      >
        {adjusting ? (
          <form id="adjust-form" className="flex flex-col gap-4" onSubmit={handleAdjust}>
            <div className="grid grid-cols-3 gap-2 rounded-md border border-border bg-muted/30 p-3 text-center">
              <div>
                <p className="text-2xs text-muted-foreground">Current</p>
                <p className="tabular mt-0.5 text-sm font-semibold">{formatAmount(adjusting.quantity)}</p>
              </div>
              <div>
                <p className="text-2xs text-muted-foreground">Change</p>
                <p className="tabular mt-0.5 text-sm font-semibold">
                  {adjustForm.delta === '' || Number.isNaN(Number(adjustForm.delta))
                    ? '—'
                    : `${Number(adjustForm.delta) > 0 ? '+' : ''}${Number(adjustForm.delta)}`}
                </p>
              </div>
              <div>
                <p className="text-2xs text-muted-foreground">Resulting</p>
                <p
                  className={`tabular mt-0.5 text-sm font-semibold ${
                    projected < 0 ? 'text-destructive' : projected < adjusting.reorder_level ? 'text-warning' : ''
                  }`}
                >
                  {adjustForm.delta === '' || Number.isNaN(Number(adjustForm.delta)) ? '—' : formatAmount(projected)}
                </p>
              </div>
            </div>

            {adjustError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
                <p className="font-medium text-destructive">{describeError(adjustError)}</p>
                {projected < 0 ? (
                  <p className="mt-1 text-muted-foreground">
                    A negative result is rejected by the database, not by this form.
                  </p>
                ) : null}
              </div>
            ) : null}

            <Field
              label="Change in units"
              required
              hint="Use a negative number to remove stock. Between −1,000,000 and 1,000,000."
            >
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  step="1"
                  inputMode="numeric"
                  value={adjustForm.delta}
                  onChange={(event) => setAdjustForm((current) => ({ ...current, delta: event.target.value }))}
                  placeholder="e.g. 25 or -4"
                  autoFocus
                  required
                />
              )}
            </Field>

            <Field label="Reason" hint="Recorded in the stock ledger next to your name.">
              {(props) => (
                <Textarea
                  {...props}
                  rows={2}
                  value={adjustForm.note}
                  onChange={(event) => setAdjustForm((current) => ({ ...current, note: event.target.value }))}
                  placeholder="Cycle count correction"
                />
              )}
            </Field>

            <p className="text-2xs text-muted-foreground">
              Adjustments are appended to an immutable ledger — nothing is overwritten.
            </p>
          </form>
        ) : null}
      </Dialog>
    </div>
  );
}