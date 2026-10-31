import { useEffect, useState } from 'react';
import { KeyRound, Plus, ShieldCheck, Trash2, UserCog, UserRound, Users as UsersIcon } from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { useApiResource } from '../hooks/useApiResource.js';
import { INTERNAL_ROLES, ROLES } from '../lib/constants.js';
import { describeError } from '../lib/errors.js';
import { formatRelative } from '../lib/format.js';
import { usersApi, warehousesApi } from '../services/endpoints.js';
import { Badge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card, CardToolbar } from '../components/ui/Card.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { Alert, EmptyState, ErrorState, TableSkeleton } from '../components/ui/Feedback.jsx';
import { Field, Input, Select } from '../components/ui/Input.jsx';
import { Pagination } from '../components/ui/Pagination.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';
import { useToast } from '../components/ui/Toast.jsx';

const ROLE_TONE = {
  [ROLES.ADMIN]: 'destructive',
  [ROLES.MANAGER]: 'primary',
  [ROLES.STAFF]: 'info',
  [ROLES.CLIENT]: 'default',
};

const EMPTY_FORM = { name: '', email: '', password: '', role: ROLES.STAFF };

/**
 * Roles an administrator may remove permanently.
 *
 * Mirrors the server-side rule in auth.service.js. It drives button visibility
 * only -- the API re-checks every condition, so a crafted request cannot delete
 * an administrator, an active account or the caller's own account.
 *
 * Staff were originally left out of this list by mistake: they could be
 * deactivated but never cleaned up, so a deactivated Staff row was stuck in the
 * table forever. They follow exactly the same rules as Client and Manager.
 */
const DELETABLE_ROLES = [ROLES.CLIENT, ROLES.MANAGER, ROLES.STAFF];

export function Users() {
  const { user: currentUser } = useAuth();
  const toast = useToast();

  const [page, setPage] = useState(1);
  const users = useApiResource(() => usersApi.list({ page, limit: 20 }), [page]);
  const warehouses = useApiResource(() => warehousesApi.list({ limit: 100 }), []);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', role: ROLES.STAFF, is_active: true });
  const [editError, setEditError] = useState(null);

  const [accessFor, setAccessFor] = useState(null);
  const [selected, setSelected] = useState([]);
  const [accessError, setAccessError] = useState(null);

  // Permanent deletion. `deleteFor` being non-null is what opens the dialog;
  // the request only closes it on success, so a failure keeps the target and
  // the reason on screen.
  const [deleteFor, setDeleteFor] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const rows = users.data ?? [];
  const meta = users.meta ?? { page, limit: 20, total: 0 };
  const warehouseList = warehouses.data ?? [];

  useEffect(() => {
    if (accessFor) {
      setSelected((accessFor.warehouse_ids ?? []).map(String));
      setAccessError(null);
    }
  }, [accessFor]);

  async function handleCreate(event) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);

    try {
      const created = await usersApi.create({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
      });
      toast.success('User created', `${created.data?.name ?? form.name} can now sign in.`);
      setCreating(false);
      setForm(EMPTY_FORM);
      users.reload();
    } catch (caught) {
      setFormError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdate(event) {
    event.preventDefault();
    setSubmitting(true);
    setEditError(null);

    try {
      const result = await usersApi.update(editing.id, {
        name: editForm.name.trim(),
        role: editForm.role,
        // Only send is_active when it changed, so a rename never silently
        // revokes the user's sessions.
        ...(editForm.is_active !== editing.is_active ? { is_active: editForm.is_active } : {}),
      });

      toast.success(
        'User updated',
        result.data?.sessions_revoked
          ? 'Their existing sessions were revoked immediately.'
          : `${editForm.name.trim()} has been saved.`,
      );
      setEditing(null);
      users.reload();
      if (editing.id === currentUser?.id) {
        // An administrator who changed their own role must see the new state.
        window.location.reload();
      }
    } catch (caught) {
      setEditError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAccess(event) {
    event.preventDefault();
    setSubmitting(true);
    setAccessError(null);

    const before = new Set((accessFor.warehouse_ids ?? []).map(String));
    const after = new Set(selected);

    try {
      await usersApi.setWarehouseAccess(accessFor.id, {
        grant: [...after].filter((id) => !before.has(id)).map(Number),
        revoke: [...before].filter((id) => !after.has(id)).map(Number),
      });
      toast.success('Access updated', `${accessFor.name} now has ${selected.length} warehouse(s).`);
      setAccessFor(null);
      users.reload();
    } catch (caught) {
      setAccessError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(target) {
    try {
      const result = await usersApi.update(target.id, { is_active: !target.is_active });
      toast.success(
        target.is_active ? 'User deactivated' : 'User reactivated',
        result.data?.sessions_revoked
          ? 'Any session they had open has been revoked.'
          : `${target.name} can sign in again.`,
      );
      users.reload();
    } catch (caught) {
      toast.error('Could not change the account', describeError(caught));
    }
  }

  /**
   * True when the row is eligible for permanent deletion: deactivated, and a
   * Client, Manager or Staff account. Administrators are never deletable, and
   * an administrator cannot remove their own account.
   */
  function canDelete(row) {
    return (
      !row.is_active &&
      DELETABLE_ROLES.includes(row.role) &&
      row.id !== currentUser?.id
    );
  }

  async function handleDelete() {
    if (!deleteFor || deleting) return;
    const target = deleteFor;

    setDeleting(true);
    setDeleteError(null);

    try {
      const result = await usersApi.remove(target.id);
      const released = result.data?.warehouses_released ?? 0;

      toast.success(
        'User permanently deleted',
        released > 0
          ? `${target.name} has been removed. ${released} warehouse${released === 1 ? '' : 's'} now need a manager.`
          : `${target.name} has been removed and can no longer sign in.`,
      );

      // Only a confirmed deletion closes the dialog and refreshes the table.
      setDeleteFor(null);
      users.reload();
    } catch (caught) {
      // The account stays in the table; the dialog keeps its details visible.
      setDeleteError(caught);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Users</h2>
          <p className="text-xs text-muted-foreground">
            {meta.total} account{meta.total === 1 ? '' : 's'}. Only administrators can change roles or
            warehouse access.
          </p>
        </div>
        <Button onClick={() => { setForm(EMPTY_FORM); setFormError(null); setCreating(true); }}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add user
        </Button>
      </div>

      <Card>
        <CardToolbar>
          <p className="text-2xs text-muted-foreground">
            A Manager is scoped to the warehouses you grant; a Client sees only their own orders.
          </p>
        </CardToolbar>

        {users.error ? (
          <ErrorState error={users.error} onRetry={users.reload} />
        ) : users.loading ? (
          <TableSkeleton rows={8} columns={5} />
        ) : rows.length === 0 ? (
          <EmptyState icon={UsersIcon} title="No users" description="Create the first account." />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>User</TH>
                  <TH>Role</TH>
                  <TH>Status</TH>
                  <TH>Warehouses</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => {
                  const isSelf = row.id === currentUser?.id;
                  const granted = (row.warehouse_ids ?? [])
                    .map((id) => warehouseList.find((warehouse) => warehouse.id === id))
                    .filter(Boolean);

                  return (
                    <TR key={row.id}>
                      <TD>
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-2xs font-semibold text-primary">
                            {row.name.slice(0, 2).toUpperCase()}
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-xs font-medium">
                              {row.name}
                              {isSelf ? <span className="ml-1.5 text-2xs text-muted-foreground">(you)</span> : null}
                            </span>
                            <span className="truncate text-2xs text-muted-foreground">{row.email}</span>
                          </span>
                        </div>
                      </TD>
                      <TD>
                        <Badge tone={ROLE_TONE[row.role] ?? 'default'}>
                          <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                          {row.role}
                        </Badge>
                      </TD>
                      <TD>
                        {row.is_active ? (
                          <Badge tone="success">Active</Badge>
                        ) : (
                          <Badge tone="outline">Disabled</Badge>
                        )}
                      </TD>
                      <TD>
                        {row.role === ROLES.ADMIN ? (
                          <span className="text-2xs text-muted-foreground">Every warehouse</span>
                        ) : row.role === ROLES.CLIENT ? (
                          <span className="text-2xs text-muted-foreground">Not applicable</span>
                        ) : granted.length === 0 ? (
                          <span className="text-2xs text-warning">None — sees no stock</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {granted.map((warehouse) => (
                              <span
                                key={warehouse.id}
                                className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
                              >
                                {warehouse.code}
                              </span>
                            ))}
                          </span>
                        )}
                      </TD>
                      <TD className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {INTERNAL_ROLES.includes(row.role) ? (
                            <Button variant="ghost" size="sm" onClick={() => setAccessFor(row)}>
                              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                              Access
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditForm({ name: row.name, role: row.role, is_active: row.is_active });
                              setEditError(null);
                              setEditing(row);
                            }}
                          >
                            <UserCog className="h-3.5 w-3.5" aria-hidden="true" />
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className={row.is_active ? 'text-destructive' : ''}
                            onClick={() => toggleActive(row)}
                            disabled={isSelf && row.is_active}
                            title={isSelf && row.is_active ? 'You cannot deactivate your own account' : undefined}
                          >
                            {row.is_active ? 'Deactivate' : 'Reactivate'}
                          </Button>
                          {/* Permanent deletion is offered only once the account
                              is already disabled, and never for administrators. */}
                          {canDelete(row) ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => {
                                setDeleteError(null);
                                setDeleteFor(row);
                              }}
                              aria-label={`Permanently delete ${row.name}`}
                              title={`Permanently delete ${row.name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              Delete
                            </Button>
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
              onPageChange={setPage}
            />
          </>
        )}
      </Card>

      {/* Create */}
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Add user"
        description="Registration through the sign-up page always creates a Client; staff accounts are created here."
        footer={
          <>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" form="user-form" loading={submitting}>
              Create user
            </Button>
          </>
        }
      >
        {formError ? (
          <div className="mb-4">
            <Alert tone="destructive" title="Could not create the user">
              {describeError(formError)}
            </Alert>
          </div>
        ) : null}

        <form id="user-form" className="flex flex-col gap-4" onSubmit={handleCreate}>
          <Field label="Full name" required error={formError?.fieldErrors?.name}>
            {(props) => (
              <Input
                {...props}
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Ama Mensah"
                required
              />
            )}
          </Field>

          <Field label="Email" required error={formError?.fieldErrors?.email}>
            {(props) => (
              <Input
                {...props}
                type="email"
                autoComplete="off"
                value={form.email}
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                placeholder="ama@stockpulse.dev"
                required
              />
            )}
          </Field>

          <Field
            label="Temporary password"
            required
            hint="At least 12 characters. Share it over a channel you trust."
            error={formError?.fieldErrors?.password}
          >
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                required
              />
            )}
          </Field>

          <Field label="Role" required hint="Warehouse access is granted after the account exists.">
            {(props) => (
              <Select
                {...props}
                value={form.role}
                onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}
              >
                {Object.values(ROLES).map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </form>
      </Dialog>

      {/* Edit */}
      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.name}` : 'Edit user'}
        description="Changing a role or disabling an account revokes the sessions that user already has open."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" form="user-edit-form" loading={submitting}>
              Save changes
            </Button>
          </>
        }
      >
        {editError ? (
          <div className="mb-4">
            <Alert tone="destructive" title="Could not save">
              {describeError(editError)}
            </Alert>
          </div>
        ) : null}

        <form id="user-edit-form" className="flex flex-col gap-4" onSubmit={handleUpdate}>
          <Field label="Full name" required>
            {(props) => (
              <Input
                {...props}
                value={editForm.name}
                onChange={(event) => setEditForm((current) => ({ ...current, name: event.target.value }))}
                required
              />
            )}
          </Field>

          <Field label="Role" hint="The last active administrator cannot be demoted.">
            {(props) => (
              <Select
                {...props}

                value={editForm.role}
                onChange={(event) => setEditForm((current) => ({ ...current, role: event.target.value }))}
              >
                {Object.values(ROLES).map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Status">
            {(props) => (
              <Select
                {...props}
                value={editForm.is_active ? 'active' : 'disabled'}
                onChange={(event) =>
                  setEditForm((current) => ({ ...current, is_active: event.target.value === 'active' }))
                }
              >
                <option value="active">Active — can sign in</option>
                <option value="disabled">Disabled — sessions revoked</option>
              </Select>
            )}
          </Field>

          <p className="flex items-start gap-1.5 text-2xs text-muted-foreground">
            <UserRound className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            {editing ? `Created ${formatRelative(editing.created_at)}` : null}
          </p>
        </form>
      </Dialog>

      {/* Warehouse access */}
      <Dialog
        open={Boolean(accessFor)}
        onClose={() => setAccessFor(null)}
        title={accessFor ? `Warehouse access — ${accessFor.name}` : 'Warehouse access'}
        description="Only the ticked warehouses appear in this user's inventory, orders and analytics."
        footer={
          <>
            <Button variant="outline" onClick={() => setAccessFor(null)}>
              Cancel
            </Button>
            <Button type="submit" form="access-form" loading={submitting}>
              Save access
            </Button>
          </>
        }
      >
        {accessError ? (
          <div className="mb-4">
            <Alert tone="destructive" title="Could not update access">
              {describeError(accessError)}
            </Alert>
          </div>
        ) : null}

        <form id="access-form" className="flex flex-col gap-2" onSubmit={handleAccess}>
          {warehouseList.length === 0 ? (
            <p className="text-xs text-muted-foreground">No warehouses exist yet.</p>
          ) : (
            warehouseList.map((warehouse) => {
              const id = String(warehouse.id);
              const checked = selected.includes(id);
              return (
                <label
                  key={warehouse.id}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border px-3 py-2 transition-colors hover:bg-accent/40"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-xs font-medium">{warehouse.name}</span>
                    <span className="font-mono text-2xs text-muted-foreground">
                      {warehouse.code}
                      {warehouse.manager ? ` · ${warehouse.manager.name}` : ''}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                    checked={checked}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, id]
                          : current.filter((value) => value !== id),
                      )
                    }
                  />
                </label>
              );
            })
          )}
        </form>
      </Dialog>

      {/* Permanent deletion -- requires an explicit second action. */}
      <Dialog
        open={Boolean(deleteFor)}
        // Escape and the backdrop are ignored while the request is in flight:
        // closing mid-request would hide whether the deletion actually happened.
        onClose={() => {
          if (!deleting) setDeleteFor(null);
        }}
        title="Permanently delete user"
        description="This action cannot be undone."
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteFor(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" loading={deleting} onClick={handleDelete}>
              Permanently Delete
            </Button>
          </>
        }
      >
        {deleteError ? (
          <div className="mb-4">
            <Alert tone="destructive" title="Could not delete the user">
              {describeError(deleteError)}
            </Alert>
          </div>
        ) : null}

        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-[4.5rem,1fr] gap-x-3 gap-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="font-medium">{deleteFor?.name}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="truncate font-mono text-2xs">{deleteFor?.email}</dd>
            <dt className="text-muted-foreground">Role</dt>
            <dd>{deleteFor?.role}</dd>
          </dl>

          <Alert tone="destructive" title="This cannot be undone">
            {deleteFor?.name} will be permanently removed and will no longer be able to sign in.
            Their historical orders and stock movements are kept so the ERP records stay intact.
          </Alert>
        </div>
      </Dialog>
    </div>
  );
}