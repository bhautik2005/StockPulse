import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Archive, Package, PackagePlus, Pencil, Plus, Search, ShoppingCart, Upload, X } from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { useApiResource, useDebouncedValue } from '../hooks/useApiResource.js';
import { canManageCatalogue } from '../lib/constants.js';
import { describeError } from '../lib/errors.js';
import { formatAmount, formatMoney, formatNumber } from '../lib/format.js';
import { catalogApi, productsApi } from '../services/endpoints.js';
import { Badge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card, CardToolbar } from '../components/ui/Card.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { EmptyState, ErrorState, TableSkeleton } from '../components/ui/Feedback.jsx';
import { Field, Input, Select } from '../components/ui/Input.jsx';
import { Pagination } from '../components/ui/Pagination.jsx';
import { Table, TBody, TD, TDNumeric, TH, THead, TR } from '../components/ui/Table.jsx';
import { Tabs } from '../components/ui/Tabs.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { ProductImportModal } from '../components/products/ProductImportModal.jsx';

const EMPTY_FORM = { sku: '', name: '', category: '', unit_price: '', reorder_level: '10' };

export function Products() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // Admins and Managers manage the catalogue; Staff and Clients see availability
  // only. Deciding this once keeps every request in this page on a legal route.
  const manages = canManageCatalogue(user?.role);

  const page = Number(searchParams.get('page') ?? 1);
  const category = searchParams.get('category') ?? '';
  const includeInactive = manages && searchParams.get('include_inactive') === 'true';
  const searchInUrl = searchParams.get('search') ?? '';

  const [search, setSearch] = useState(searchInUrl);
  const debouncedSearch = useDebouncedValue(search, 350);

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const products = useApiResource(
    () =>
      manages
        ? productsApi.list({
            page,
            limit: 20,
            search: debouncedSearch || undefined,
            category: category || undefined,
            include_inactive: includeInactive ? 'true' : undefined,
          })
        : catalogApi.list({
            page,
            limit: 20,
            search: debouncedSearch || undefined,
            category: category || undefined,
          }),
    [manages, page, category, includeInactive, debouncedSearch],
  );

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

  const rows = products.data ?? [];
  const meta = products.meta ?? { page, limit: 20, total: 0 };

  /*
   * Categories are derived from what is loaded, because the API has no
   * categories endpoint. They therefore describe this page's products rather
   * than the whole catalogue -- which is why the strip is labelled as a filter
   * over the current view and not as a complete taxonomy.
   */
  const categories = useMemo(() => {
    const found = new Set();
    for (const product of rows) if (product.category) found.add(product.category);
    return [...found].sort();
  }, [rows]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setError(null);
    setEditing({ id: null });
  }

  function openEdit(product) {
    setForm({
      sku: product.sku,
      name: product.name,
      category: product.category ?? '',
      unit_price: String(product.unit_price),
      reorder_level: String(product.reorder_level ?? 10),
    });
    setError(null);
    setEditing(product);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      if (editing.id) {
        await productsApi.update(editing.id, {
          name: form.name.trim(),
          category: form.category.trim() || null,
          unit_price: form.unit_price,
          reorder_level: Number(form.reorder_level),
        });
        toast.success('Product updated', `${form.name.trim()} has been saved.`);
      } else {
        await productsApi.create({
          sku: form.sku.trim(),
          name: form.name.trim(),
          category: form.category.trim() || undefined,
          unit_price: form.unit_price,
          reorder_level: Number(form.reorder_level),
        });
        toast.success('Product created', `${form.sku.trim()} is now in the catalogue.`);
      }
      setEditing(null);
      products.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleArchive(product) {
    try {
      await productsApi.archive(product.id);
      toast.success('Product archived', `${product.sku} is hidden from new orders.`);
      products.reload();
    } catch (caught) {
      toast.error('Could not archive product', describeError(caught));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">
            {manages ? 'Products' : 'Catalogue'}
          </h2>
          <p className="text-xs text-muted-foreground">
            {manages
              ? `${meta.total} product${meta.total === 1 ? '' : 's'} in the catalogue.`
              : `${meta.total} product${meta.total === 1 ? '' : 's'} available to order.`}
          </p>
        </div>

        {manages ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" aria-hidden="true" />
              Import products
            </Button>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add product
            </Button>
          </div>
        ) : null}
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
              placeholder="Search by SKU or name"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search products"
            />
          </div>

          {manages ? (
            <Button
              variant={includeInactive ? 'default' : 'outline'}
              size="sm"
              onClick={() => updateParams({ include_inactive: includeInactive ? null : 'true' })}
              aria-pressed={includeInactive}
            >
              <Archive className="h-3.5 w-3.5" aria-hidden="true" />
              Include archived
            </Button>
          ) : null}

          {searchInUrl || category || includeInactive ? (
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

        {categories.length > 1 || category ? (
          <CardToolbar className="border-t border-border">
            <Tabs
              value={category}
              onValueChange={(value) => updateParams({ category: value })}
              tabs={[{ value: '', label: 'All categories' }, ...categories.map((name) => ({ value: name, label: name }))]}
            />
          </CardToolbar>
        ) : null}

        {products.error ? (
          <ErrorState error={products.error} onRetry={products.reload} />
        ) : products.loading ? (
          <TableSkeleton rows={8} columns={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={manages ? PackagePlus : Package}
            title={searchInUrl || category ? 'No products match' : 'The catalogue is empty'}
            description={
              manages
                ? 'Add a product to start tracking it across warehouses.'
                : 'Nothing is available to order right now.'
            }
            action={manages && !searchInUrl ? <Button onClick={openCreate}>Add product</Button> : null}
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>Category</TH>
                  <TH className="text-right">Unit price</TH>
                  <TH className="text-right">{manages ? 'On hand' : 'Available'}</TH>
                  {manages ? <TH className="text-right">Reorder level</TH> : null}
                  <TH className="text-right">Status</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((product) => {
                  const onHand = manages ? product.total_quantity : product.available;
                  const out = !onHand || onHand <= 0;
                  const low = manages && !out && onHand <= (product.reorder_level ?? 0);

                  return (
                    <TR key={product.id}>
                      <TD>
                        <div className="flex items-center gap-2.5">
                          {/* No image column exists in the schema, so a monogram
                              stands in for a thumbnail rather than a broken src. */}
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 font-mono text-2xs text-muted-foreground">
                            {product.sku.slice(0, 2).toUpperCase()}
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-xs font-medium">{product.name}</span>
                            <span className="font-mono text-2xs text-muted-foreground">{product.sku}</span>
                          </span>
                        </div>
                      </TD>
                      <TD className="text-xs text-muted-foreground">{product.category ?? '—'}</TD>
                      <TDNumeric className="text-xs">{formatMoney(product.unit_price)}</TDNumeric>
                      <TDNumeric className="text-xs">
                        <span className={low ? 'font-semibold text-warning' : ''}>{formatAmount(onHand)}</span>
                        {low ? (
                          <Badge tone="warning" className="ml-2 align-middle">
                            Low
                          </Badge>
                        ) : null}
                      </TDNumeric>
                      {manages ? (
                        <TDNumeric className="text-xs text-muted-foreground">
                          {formatAmount(product.reorder_level)}
                        </TDNumeric>
                      ) : null}
                      <TD className="text-right">
                        {manages ? (
                          product.is_active ? (
                            <Badge tone="success">Active</Badge>
                          ) : (
                            <Badge tone="outline">Archived</Badge>
                          )
                        ) : out ? (
                          <Badge tone="outline">Out of stock</Badge>
                        ) : (
                          <Badge tone="success">{formatNumber(onHand)} available</Badge>
                        )}
                      </TD>
                      <TD className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(`/orders?new=1&product_id=${product.id}`)}
                            disabled={out}
                            title={out ? 'No stock available' : 'Add to a new order'}
                          >
                            <ShoppingCart className="h-3.5 w-3.5" aria-hidden="true" />
                            Order
                          </Button>

                          {manages ? (
                            <>
                              <Button variant="ghost" size="sm" onClick={() => openEdit(product)}>
                                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                Edit
                              </Button>
                              {product.is_active ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive"
                                  onClick={() => handleArchive(product)}
                                >
                                  <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                                  Archive
                                </Button>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      </TD>
                    </TR>
                  );
                })}
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
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? `Edit ${editing.sku}` : 'Add product'}
        description={
          editing?.id
            ? 'The SKU is permanent: order history and the ledger reference it.'
            : 'Prices are stored with two decimal places, exactly as entered.'
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" form="product-form" loading={submitting}>
              {editing?.id ? 'Save changes' : 'Create product'}
            </Button>
          </>
        }
      >
        {error ? (
          <div className="mb-4">
            <ErrorState error={error} />
          </div>
        ) : null}

        <form id="product-form" className="flex flex-col gap-4" onSubmit={handleSubmit}>
          {!editing?.id ? (
            <Field
              label="SKU"
              required
              hint="Letters, digits, dot, underscore and hyphen only."
              error={error?.fieldErrors?.sku}
            >
              {(props) => (
                <Input
                  {...props}
                  value={form.sku}
                  onChange={(event) => setForm((current) => ({ ...current, sku: event.target.value }))}
                  placeholder="ACC-1001"
                  required
                />
              )}
            </Field>
          ) : null}

          <Field label="Name" required error={error?.fieldErrors?.name}>
            {(props) => (
              <Input
                {...props}
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Stainless steel coupling, 50mm"
                required
              />
            )}
          </Field>

          <Field label="Category" error={error?.fieldErrors?.category}>
            {(props) => (
              <Input
                {...props}
                value={form.category}
                onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
                placeholder="Fittings"
              />
            )}
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Unit price"
              required
              hint="At most two decimals."
              error={error?.fieldErrors?.unit_price}
            >
              {(props) => (
                <Input
                  {...props}
                  inputMode="decimal"
                  value={form.unit_price}
                  onChange={(event) => setForm((current) => ({ ...current, unit_price: event.target.value }))}
                  placeholder="19.99"
                  required
                />
              )}
            </Field>

            <Field
              label="Reorder level"
              hint="Low-stock alerts trigger at or below this."
              error={error?.fieldErrors?.reorder_level}
            >
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min="0"
                  step="1"
                  value={form.reorder_level}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, reorder_level: event.target.value }))
                  }
                />
              )}
            </Field>
          </div>
        </form>
      </Dialog>

      <ProductImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onSuccess={(importResult) => {
          products.reload();
          if (importResult?.warehouse?.name) {
            toast.success(
              'Import completed',
              `Successfully imported ${importResult.successCount} products into ${importResult.warehouse.name} with initial stock.`,
            );
          }
        }}
      />
    </div>
  );
}