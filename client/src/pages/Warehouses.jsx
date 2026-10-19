import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Boxes, MapPin, Package, Pencil, Plus, UserRound, Warehouse as WarehouseIcon } from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { useApiResource } from '../hooks/useApiResource.js';
import { ROLES } from '../lib/constants.js';
import { describeError } from '../lib/errors.js';
import { formatNumber } from '../lib/format.js';
import { usersApi, warehousesApi } from '../services/endpoints.js';
import { Badge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card } from '../components/ui/Card.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/Feedback.jsx';
import { Field, Input, Select } from '../components/ui/Input.jsx';
import { useToast } from '../components/ui/Toast.jsx';

const EMPTY_FORM = { code: '', name: '', location: '', manager_id: '', is_active: true };

export function Warehouses() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const warehouses = useApiResource(() => warehousesApi.list({ limit: 100 }), []);
  // Only an Admin may list users, so the manager picker is loaded conditionally.
  const users = useApiResource(() => usersApi.list({ limit: 100 }), [], { skip: !isAdmin });

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const managers = useMemo(
    () => (users.data ?? []).filter((user) => user.role === ROLES.MANAGER && user.is_active),
    [users.data],
  );

  // A Manager owns at most one warehouse (a database constraint), so a manager
  // already assigned elsewhere is shown but cannot be picked again.
  const takenManagerIds = useMemo(() => {
    const taken = new Map();
    for (const warehouse of warehouses.data ?? []) {
      if (warehouse.manager?.id && warehouse.id !== editing?.id) taken.set(warehouse.manager.id, warehouse.code);
    }
    return taken;
  }, [warehouses.data, editing]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setError(null);
    setEditing({ id: null });
  }

  function openEdit(warehouse) {
    setForm({
      code: warehouse.code,
      name: warehouse.name,
      location: warehouse.location ?? '',
      manager_id: warehouse.manager?.id ? String(warehouse.manager.id) : '',
      is_active: warehouse.is_active,
    });
    setError(null);
    setEditing(warehouse);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const payload = {
      name: form.name.trim(),
      location: form.location.trim() || null,
      manager_id: form.manager_id ? Number(form.manager_id) : null,
    };

    try {
      if (editing.id) {
        await warehousesApi.update(editing.id, { ...payload, is_active: form.is_active });
        toast.success('Warehouse updated', `${payload.name} has been saved.`);
      } else {
        await warehousesApi.create({ ...payload, code: form.code.trim() });
        toast.success('Warehouse created', `${payload.name} is ready for stock.`);
      }
      setEditing(null);
      warehouses.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  const rows = warehouses.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Warehouses</h2>
          <p className="text-xs text-muted-foreground">
            {rows.length} location{rows.length === 1 ? '' : 's'} in your scope.
          </p>
        </div>
        {isAdmin ? (
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add warehouse
          </Button>
        ) : null}
      </div>

      {warehouses.error ? (
        <Card>
          <ErrorState error={warehouses.error} onRetry={warehouses.reload} />
        </Card>
      ) : warehouses.loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-44 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={WarehouseIcon}
            title="No warehouses in your scope"
            description={
              isAdmin
                ? 'Create the first location to start receiving stock.'
                : 'An administrator has not assigned you to a warehouse yet.'
            }
            action={isAdmin ? <Button onClick={openCreate}>Add warehouse</Button> : null}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((warehouse) => (
            <Card key={warehouse.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-semibold">{warehouse.name}</h3>
                    {!warehouse.is_active ? <Badge tone="outline">Inactive</Badge> : null}
                  </div>
                  <p className="mt-0.5 font-mono text-2xs text-muted-foreground">{warehouse.code}</p>
                </div>
                <div className="rounded-md border border-border bg-muted/40 p-1.5">
                  <WarehouseIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                </div>
              </div>

              <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {warehouse.location || 'No address recorded'}
                </p>

                {/*
                  The API reports these counts on the list endpoint. There is no
                  capacity field in the schema, so "utilisation" is deliberately
                  absent rather than invented.
                */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border border-border bg-muted/30 p-2">
                    <p className="flex items-center gap-1 text-2xs text-muted-foreground">
                      <Package className="h-3 w-3" aria-hidden="true" />
                      Products
                    </p>
                    <p className="tabular mt-0.5 text-sm font-semibold">
                      {formatNumber(warehouse.counts?.products ?? 0)}
                    </p>
                  </div>
                  <div className="rounded-md border border-border bg-muted/30 p-2">
                    <p className="flex items-center gap-1 text-2xs text-muted-foreground">
                      <Boxes className="h-3 w-3" aria-hidden="true" />
                      Units on hand
                    </p>
                    <p className="tabular mt-0.5 text-sm font-semibold">
                      {formatNumber(warehouse.counts?.units_on_hand ?? 0)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 rounded-md border border-border p-2">
                  {warehouse.manager ? (
                    <>
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-2xs font-semibold text-primary">
                        {warehouse.manager.name.slice(0, 1)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-xs">{warehouse.manager.name}</p>
                        <p className="truncate text-2xs text-muted-foreground">{warehouse.manager.email}</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <UserRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      <p className="text-xs text-muted-foreground">No manager assigned</p>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 border-t border-border p-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  // The blueprint's "deep link to inventory filtered by that
                  // warehouse" -- the filter lives in the URL so the view is
                  // shareable and survives a reload.
                  onClick={() => navigate(`/inventory?warehouse_id=${warehouse.id}`)}
                >
                  <Boxes className="h-3.5 w-3.5" aria-hidden="true" />
                  View inventory
                </Button>
                <Button variant="ghost" size="sm" onClick={() => openEdit(warehouse)} disabled={!isAdmin}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  Edit
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? `Edit ${editing.name}` : 'Add warehouse'}
        description={
          editing?.id
            ? 'Renaming a warehouse does not affect historical orders.'
            : 'A warehouse is a physical location that holds stock.'
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" form="warehouse-form" loading={submitting}>
              {editing?.id ? 'Save changes' : 'Create warehouse'}
            </Button>
          </>
        }
      >
        {error ? (
          <div className="mb-4">
            <ErrorState error={error} />
          </div>
        ) : null}

        <form id="warehouse-form" className="flex flex-col gap-4" onSubmit={handleSubmit}>
          {!editing?.id ? (
            <Field
              label="Code"
              required
              hint="Short identifier used on reports, e.g. WH-NBO."
              error={error?.fieldErrors?.code}
            >
              {(props) => (
                <Input
                  {...props}
                  value={form.code}
                  onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
                  placeholder="WH-ACC"
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
                placeholder="Accra Distribution Centre"
                required
              />
            )}
          </Field>

          <Field label="Location" error={error?.fieldErrors?.location}>
            {(props) => (
              <Input
                {...props}
                value={form.location}
                onChange={(event) => setForm((current) => ({ ...current, location: event.target.value }))}
                placeholder="Tema Port Road, Accra, GH"
              />
            )}
          </Field>

          <Field
            label="Manager"
            hint="One manager per warehouse; the database enforces it."
            error={error?.fieldErrors?.manager_id}
          >
            {(props) => (
              <Select
                {...props}
                value={form.manager_id}
                onChange={(event) => setForm((current) => ({ ...current, manager_id: event.target.value }))}
              >
                <option value="">Unassigned</option>
                {managers.map((manager) => {
                  const takenBy = takenManagerIds.get(manager.id);
                  return (
                    <option key={manager.id} value={manager.id} disabled={Boolean(takenBy)}>
                      {manager.name}
                      {takenBy ? ` — already manages ${takenBy}` : ''}
                    </option>
                  );
                })}
              </Select>
            )}
          </Field>

          {editing?.id ? (
            <Field label="Status">
              {(props) => (
                <Select
                  {...props}
                  value={form.is_active ? 'active' : 'inactive'}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, is_active: event.target.value === 'active' }))
                  }
                >
                  <option value="active">Active — can receive stock</option>
                  <option value="inactive">Inactive — retained for history</option>
                </Select>
              )}
            </Field>
          ) : null}
        </form>

        {!editing?.id && managers.length === 0 && !users.loading ? (
          <p className="mt-4 text-2xs text-muted-foreground">
            No active managers exist yet.{' '}
            <Link to="/users" className="focus-ring rounded text-primary hover:underline">
              Create one
            </Link>{' '}
            to assign ownership.
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}