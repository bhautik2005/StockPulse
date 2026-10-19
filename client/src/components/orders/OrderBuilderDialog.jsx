import { useEffect, useMemo, useState } from 'react';
import { Plus, Search, ShoppingCart, Trash2, TriangleAlert } from 'lucide-react';

import { useAuth } from '../../context/AuthContext.jsx';
import { useApiResource, useDebouncedValue } from '../../hooks/useApiResource.js';
import { canManageCatalogue } from '../../lib/constants.js';
import { describeError } from '../../lib/errors.js';
import { formatMoney, formatNumber } from '../../lib/format.js';
import { newIdempotencyKey } from '../../lib/utils.js';
import { catalogApi, ordersApi, productsApi, warehousesApi } from '../../services/endpoints.js';
import { Button } from '../ui/Button.jsx';
import { Dialog } from '../ui/Dialog.jsx';
import { Alert, Spinner } from '../ui/Feedback.jsx';
import { Field, Input, Select } from '../ui/Input.jsx';
import { Table, TBody, TD, TDNumeric, TH, THead, TR } from '../ui/Table.jsx';
import { useToast } from '../ui/Toast.jsx';

/**
 * Exact money arithmetic for the on-screen estimate.
 *
 * Prices arrive as decimal strings with at most two places. Scaling to whole
 * cents before multiplying keeps this exact -- `0.1 + 0.2` style errors cannot
 * appear in a subtotal -- and the final division is display formatting of an
 * integer. The amount that is actually charged is still computed and stored by
 * the database from the catalogue price at the moment of the order.
 */
function toCents(price) {
  const [whole = '0', fraction = ''] = String(price ?? '0').split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
}

function formatCents(cents) {
  return (cents / 100).toFixed(2);
}

export function OrderBuilderDialog({ open, onClose, onCreated, prefillProductId = null }) {
  const { user, isClient, isInternal } = useAuth();
  const toast = useToast();

  // `/api/products` is Admin/Manager only; Staff and Clients read the catalogue
  // endpoint, which exposes aggregate availability and no warehouse breakdown.
  const managesCatalogue = canManageCatalogue(user?.role);

  // A Client is not allowed to list warehouses, and does not need to: the
  // service allocates each line to the warehouse holding the most stock.
  const products = useApiResource(
    () => (managesCatalogue ? productsApi.list({ limit: 100 }) : catalogApi.list({ limit: 100 })),
    [],
    { skip: !open },
  );
  const warehouses = useApiResource(() => warehousesApi.list({ limit: 100 }), [], {
    skip: !open || isClient,
  });

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  // One key per attempt at this basket. It is only replaced after the order
  // succeeds, so pressing "Place order" twice after a timeout returns the first
  // order instead of creating a duplicate.
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());

  useEffect(() => {
    if (open) {
      setLines([]);
      setError(null);
      setSearch('');
      setPrefilled(false);
      setIdempotencyKey(newIdempotencyKey());
    }
  }, [open]);

  // Deep link from the catalogue: /orders?new=1&product_id=7 opens the builder
  // with that product already on the order.
  useEffect(() => {
    if (!open || prefilled || !prefillProductId || products.loading) return;
    const product = (products.data ?? []).find((candidate) => candidate.id === Number(prefillProductId));
    if (product) {
      addProduct(product);
      setPrefilled(true);
    }
  }, [open, prefillProductId, prefilled, products.loading, products.data]);

  const available = products.data ?? [];

  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    if (!term) return available;
    return available.filter(
      (product) =>
        product.name.toLowerCase().includes(term) || product.sku.toLowerCase().includes(term),
    );
  }, [available, debouncedSearch]);

  const linesWithProduct = lines.map((line) => {
    const product = available.find((candidate) => candidate.id === line.product_id);
    return { ...line, product };
  });

  const subtotalCents = linesWithProduct.reduce(
    (sum, line) => sum + (line.product ? toCents(line.product.unit_price) * line.quantity : 0),
    0,
  );

  function addProduct(product) {
    setLines((current) => {
      const existing = current.find((line) => line.product_id === product.id && !line.warehouse_id);
      if (existing) {
        return current.map((line) =>
          line === existing ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [...current, { product_id: product.id, quantity: 1, warehouse_id: '' }];
    });
  }

  function updateLine(index, changes) {
    setLines((current) => current.map((line, position) => (position === index ? { ...line, ...changes } : line)));
  }

  function removeLine(index) {
    setLines((current) => current.filter((_, position) => position !== index));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (lines.length === 0) {
      setError({ message: 'Add at least one product to the order.' });
      return;
    }

    setSubmitting(true);
    setError(null);

    const items = lines.map((line) => ({
      product_id: line.product_id,
      quantity: Number(line.quantity),
      ...(line.warehouse_id ? { warehouse_id: Number(line.warehouse_id) } : {}),
    }));

    try {
      const result = await ordersApi.create({ items }, idempotencyKey);
      const order = result.data;
      const replayed = result.meta?.idempotent_replay;

      toast.success(
        replayed ? 'Order was already placed' : 'Order placed',
        `${order.order_number} · ${formatMoney(order.total_amount, order.currency)}`,
      );
      setIdempotencyKey(newIdempotencyKey());
      onClose();
      onCreated?.(order);
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  const conflicts = error?.stockConflicts ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="New order"
      description={
        isClient
          ? 'Stock is allocated automatically from the warehouse holding the most units.'
          : 'Leave the warehouse blank to let the service choose the best location per line.'
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="order-builder" loading={submitting} disabled={lines.length === 0}>
            <ShoppingCart className="h-4 w-4" aria-hidden="true" />
            Place order
          </Button>
        </>
      }
    >
      <form id="order-builder" className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {error ? (
          <Alert tone="destructive" title={describeError(error)}>
            {conflicts.length > 0 ? (
              <ul className="mt-1 flex flex-col gap-1">
                {conflicts.map((conflict, index) => (
                  <li key={index}>
                    Product #{conflict.product_id}
                    {conflict.warehouse_id ? ` at warehouse #${conflict.warehouse_id}` : ''}: requested{' '}
                    {formatNumber(conflict.requested)}, available {formatNumber(conflict.available)}.
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1">No stock was reserved. Adjust the quantities and try again.</p>
            )}
          </Alert>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                className="pl-8"
                placeholder="Filter products"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Filter products"
              />
            </div>

            <div className="max-h-64 overflow-y-auto rounded-md border border-border">
              {products.loading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                  <Spinner />
                  Loading catalogue…
                </div>
              ) : filtered.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                  No products match “{debouncedSearch}”.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {filtered.map((product) => {
                    const stock = isClient ? product.available : product.total_quantity;
                    const out = !stock || stock <= 0;
                    return (
                      <li key={product.id}>
                        <button
                          type="button"
                          onClick={() => addProduct(product)}
                          disabled={out}
                          className="focus-ring flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-xs font-medium">{product.name}</span>
                            <span className="block font-mono text-2xs text-muted-foreground">
                              {product.sku}
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="tabular block text-xs">
                              {formatMoney(product.unit_price)}
                            </span>
                            <span className="tabular block text-2xs text-muted-foreground">
                              {out ? 'out of stock' : `${formatNumber(stock)} available`}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              Order lines
            </p>

            {linesWithProduct.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border py-8 text-center">
                <Plus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <p className="text-xs text-muted-foreground">
                  Pick products from the list to build the order.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {linesWithProduct.map((line, index) => (
                  <div key={`${line.product_id}-${index}`} className="rounded-md border border-border p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium">
                          {line.product?.name ?? `Product #${line.product_id}`}
                        </p>
                        <p className="font-mono text-2xs text-muted-foreground">
                          {line.product?.sku} · {formatMoney(line.product?.unit_price)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeLine(index)}
                        className="focus-ring rounded text-muted-foreground transition-colors hover:text-destructive"
                        aria-label={`Remove ${line.product?.name ?? 'line'}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="mt-2 flex items-end gap-2">
                      <Field label="Quantity" className="w-24">
                        {(props) => (
                          <Input
                            {...props}
                            type="number"
                            min="1"
                            step="1"
                            value={line.quantity}
                            onChange={(event) =>
                              updateLine(index, { quantity: Math.max(1, Number(event.target.value) || 1) })
                            }
                          />
                        )}
                      </Field>

                      {isInternal ? (
                        <Field label="Warehouse" className="flex-1">
                          {(props) => (
                            <Select
                              {...props}
                              value={line.warehouse_id}
                              onChange={(event) => updateLine(index, { warehouse_id: event.target.value })}
                            >
                              <option value="">Auto — most stock</option>
                              {(warehouses.data ?? []).map((warehouse) => (
                                <option key={warehouse.id} value={warehouse.id}>
                                  {warehouse.code}
                                </option>
                              ))}
                            </Select>
                          )}
                        </Field>
                      ) : null}

                      <div className="w-20 pb-1.5 text-right">
                        <p className="tabular text-xs">
                          {line.product
                            ? formatMoney(formatCents(toCents(line.product.unit_price) * line.quantity))
                            : '—'}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {linesWithProduct.length > 0 ? (
              <div className="mt-auto flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                <span className="text-xs text-muted-foreground">
                  {lines.length} line{lines.length === 1 ? '' : 's'} · estimate
                </span>
                <span className="tabular text-sm font-semibold">{formatMoney(formatCents(subtotalCents))}</span>
              </div>
            ) : null}

            <p className="flex items-start gap-1.5 text-2xs text-muted-foreground">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              The estimate is indicative. The order is priced by the server from catalogue prices at
              the moment it is placed.
            </p>
          </div>
        </div>
      </form>
    </Dialog>
  );
}