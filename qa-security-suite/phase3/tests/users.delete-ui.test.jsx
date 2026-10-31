/**
 * Phase 3 :: Users page -- permanent deletion of deactivated accounts.
 *
 * The rules under test are the ones an operator would notice:
 *   - Delete appears ONLY on a deactivated Client or Manager;
 *   - it takes a second, explicit confirmation before anything is sent;
 *   - Cancel really cancels;
 *   - a failure keeps the account in the table and explains why;
 *   - a double click cannot send two requests.
 *
 * The server re-checks every rule (see tests/p0-users-delete.test.js); these
 * tests are about the interface not lying to the operator.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../../client/src/components/ui/Toast.jsx';
import { AuthProvider } from '../../../client/src/context/AuthContext.jsx';
import { Users } from '../../../client/src/pages/Users.jsx';
import { apiError } from '../helpers/doubles.js';

const api = vi.hoisted(() => ({
  me: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setWarehouseAccess: vi.fn(),
  warehouses: vi.fn(),
}));

vi.mock('../../../client/src/services/endpoints.js', () => ({
  authApi: { me: api.me },
  usersApi: {
    list: api.list,
    create: api.create,
    update: api.update,
    remove: api.remove,
    setWarehouseAccess: api.setWarehouseAccess,
  },
  warehousesApi: { list: api.warehouses },
}));

const ADMIN = {
  id: 1,
  name: 'Ada Admin',
  email: 'ada@stockpulse.test',
  role: 'Admin',
  is_active: true,
  warehouse_ids: [],
};
const ACTIVE_CLIENT = {
  id: 2,
  name: 'Carl Client',
  email: 'carl@acme.test',
  role: 'Client',
  is_active: true,
  warehouse_ids: [],
};
const DORMANT_CLIENT = {
  id: 3,
  name: 'Dina Dormant',
  email: 'dina@acme.test',
  role: 'Client',
  is_active: false,
  warehouse_ids: [],
};
const DORMANT_MANAGER = {
  id: 4,
  name: 'Mo Manager',
  email: 'mo@stockpulse.test',
  role: 'Manager',
  is_active: false,
  warehouse_ids: [1],
};
const DORMANT_ADMIN = {
  id: 5,
  name: 'Al Admin',
  email: 'al@stockpulse.test',
  role: 'Admin',
  is_active: false,
  warehouse_ids: [],
};
const DORMANT_STAFF = {
  id: 6,
  name: 'Sam Staff',
  email: 'sam@stockpulse.test',
  role: 'Staff',
  is_active: false,
  warehouse_ids: [],
};

const ALL_USERS = [ADMIN, ACTIVE_CLIENT, DORMANT_CLIENT, DORMANT_MANAGER, DORMANT_ADMIN, DORMANT_STAFF];

let deletedIds;
let reactivatedIds;

function renderUsers() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <Users />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** The <tr> for a user, so row-scoped assertions cannot match another row. */
function rowOf(name) {
  const cell = screen.getByText(name);
  const row = cell.closest('tr');
  if (!row) throw new Error(`No table row for ${name}`);
  return row;
}

/** Opens the confirmation dialog for a user by clicking that row's Delete. */
async function openDeleteDialog(user, name) {
  await user.click(screen.getByLabelText(`Permanently delete ${name}`));
  return screen.getByRole('dialog', { name: /permanently delete user/i });
}

describe('Phase 3 :: Users -- permanent deletion', () => {
  beforeEach(() => {
    deletedIds = new Set();
    reactivatedIds = new Set();

    api.me.mockResolvedValue({
      data: { id: ADMIN.id, name: ADMIN.name, role: 'Admin', scope: { all: true, ids: null } },
    });
    api.warehouses.mockResolvedValue({
      data: [{ id: 1, code: 'WH-NBO', name: 'Nairobi DC' }],
      meta: { page: 1, limit: 100, total: 1 },
    });

    api.list.mockImplementation(() => {
      const rows = ALL_USERS.filter((user) => !deletedIds.has(user.id)).map((user) =>
        // Reactivation flips the row back to active, which is what makes the
        // Delete button disappear on the next render.
        reactivatedIds.has(user.id) ? { ...user, is_active: true } : user,
      );
      return Promise.resolve({ data: rows, meta: { page: 1, limit: 20, total: rows.length } });
    });

    api.remove.mockImplementation((id) => {
      deletedIds.add(id);
      return Promise.resolve({ data: { id, warehouses_released: 0, history: { orders: 0 } } });
    });

    api.update.mockImplementation((id, changes) => {
      if (changes.is_active === true) reactivatedIds.add(id);
      if (changes.is_active === false) reactivatedIds.delete(id);
      return Promise.resolve({ data: { sessions_revoked: true } });
    });
  });

  it('offers Delete for every deactivated account except administrators', async () => {
    renderUsers();
    await screen.findByText('Dina Dormant');

    // Eligible: deactivated Client, Manager and Staff.
    expect(screen.getByLabelText('Permanently delete Dina Dormant')).toBeInTheDocument();
    expect(screen.getByLabelText('Permanently delete Mo Manager')).toBeInTheDocument();
    expect(screen.getByLabelText('Permanently delete Sam Staff')).toBeInTheDocument();

    // Not eligible: active accounts and administrators (even disabled).
    expect(screen.queryByLabelText('Permanently delete Carl Client')).toBeNull();
    expect(screen.queryByLabelText('Permanently delete Ada Admin')).toBeNull();
    expect(screen.queryByLabelText('Permanently delete Al Admin')).toBeNull();
  });

  it('gives a deactivated staff user the same actions as a manager', async () => {
    renderUsers();
    await screen.findByText('Sam Staff');

    const staffRow = rowOf('Sam Staff');
    const managerRow = rowOf('Mo Manager');

    // Same three actions, in the same order, as the already-working roles.
    for (const row of [staffRow, managerRow]) {
      const labels = Array.from(row.querySelectorAll('button')).map((b) => b.textContent.trim());
      expect(labels).toEqual(['Access', 'Edit', 'Reactivate', 'Delete']);
    }

    expect(within(staffRow).getByLabelText('Permanently delete Sam Staff')).toBeInTheDocument();
  });

  it('keeps Deactivate and Reactivate working alongside Delete', async () => {
    const user = userEvent.setup();
    renderUsers();
    await screen.findByText('Dina Dormant');

    // Active row: Deactivate, no Delete.
    const activeRow = rowOf('Carl Client');
    expect(within(activeRow).getByRole('button', { name: /deactivate/i })).toBeInTheDocument();
    expect(within(activeRow).queryByLabelText(/permanently delete/i)).toBeNull();
    await user.click(within(activeRow).getByRole('button', { name: /deactivate/i }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(ACTIVE_CLIENT.id, { is_active: false }));

    // Deactivated row: Reactivate and Delete together.
    const dormantRow = rowOf('Dina Dormant');
    expect(within(dormantRow).getByRole('button', { name: /reactivate/i })).toBeInTheDocument();
    expect(within(dormantRow).getByLabelText(/permanently delete/i)).toBeInTheDocument();
    await user.click(within(dormantRow).getByRole('button', { name: /reactivate/i }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(DORMANT_CLIENT.id, { is_active: true }));
  });

  it('confirms before deleting, showing who is about to be removed', async () => {
    const user = userEvent.setup();
    renderUsers();
    await screen.findByText('Dina Dormant');

    const dialog = await openDeleteDialog(user, 'Dina Dormant');

    expect(within(dialog).getByText('Dina Dormant')).toBeInTheDocument();
    expect(within(dialog).getByText('dina@acme.test')).toBeInTheDocument();
    expect(within(dialog).getByText('Client')).toBeInTheDocument();
    // The irreversible part is stated, not implied. (Exact match: the dialog
    // description "This action cannot be undone." is a separate element.)
    expect(within(dialog).getByText('This cannot be undone')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Permanently Delete' })).toBeInTheDocument();

    // Nothing is sent merely by opening the dialog.
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('does not delete anything when the dialog is cancelled', async () => {
    const user = userEvent.setup();
    renderUsers();
    await screen.findByText('Dina Dormant');

    const dialog = await openDeleteDialog(user, 'Dina Dormant');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /permanently delete user/i })).toBeNull(),
    );
    expect(api.remove).not.toHaveBeenCalled();
    expect(screen.getByText('Dina Dormant')).toBeInTheDocument();
  });

  it('deletes on confirmation, removes the row and reports success', async () => {
    const user = userEvent.setup();
    renderUsers();
    await screen.findByText('Dina Dormant');
    expect(screen.getByText('6 accounts. Only administrators can change roles or warehouse access.')).toBeInTheDocument();

    const dialog = await openDeleteDialog(user, 'Dina Dormant');
    await user.click(within(dialog).getByRole('button', { name: 'Permanently Delete' }));

    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(DORMANT_CLIENT.id));

    // Dialog closes, the row goes, the count follows, and the toast confirms it.
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /permanently delete user/i })).toBeNull(),
    );
    await waitFor(() => expect(screen.queryByText('Dina Dormant')).toBeNull());
    expect(screen.getByText('5 accounts. Only administrators can change roles or warehouse access.')).toBeInTheDocument();
    expect(screen.getByText('User permanently deleted')).toBeInTheDocument();

    // The other rows are untouched.
    expect(screen.getByText('Mo Manager')).toBeInTheDocument();
    expect(screen.getByText('Carl Client')).toBeInTheDocument();
  });

  it('keeps the account and explains the failure when deletion is refused', async () => {
    const user = userEvent.setup();
    api.remove.mockRejectedValue(
      apiError(409, {
        code: 'USER_HAS_HISTORY',
        message: 'This account is referenced by 2 orders, which must be preserved.',
      }),
    );

    renderUsers();
    await screen.findByText('Dina Dormant');

    const dialog = await openDeleteDialog(user, 'Dina Dormant');
    await user.click(within(dialog).getByRole('button', { name: 'Permanently Delete' }));

    // The dialog stays open with the reason on screen.
    await waitFor(() =>
      expect(within(dialog).getByText(/which must be preserved/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('dialog', { name: /permanently delete user/i })).toBeInTheDocument();
    // Still in the table -- the dialog also shows the name, so scope to the table.
    expect(within(screen.getByRole('table')).getByText('Dina Dormant')).toBeInTheDocument();
    expect(screen.queryByText('User permanently deleted')).toBeNull();
    // Still usable for a retry.
    expect(within(dialog).getByRole('button', { name: 'Permanently Delete' })).toBeEnabled();
  });

  it('locks the confirm button while the request is in flight', async () => {
    const user = userEvent.setup();
    let resolveRemove;
    api.remove.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRemove = resolve;
        }),
    );

    renderUsers();
    await screen.findByText('Dina Dormant');

    const dialog = await openDeleteDialog(user, 'Dina Dormant');
    const confirm = within(dialog).getByRole('button', { name: 'Permanently Delete' });
    await user.click(confirm);

    // A second click cannot produce a second request.
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(api.remove).toHaveBeenCalledTimes(1);

    resolveRemove({ data: { id: DORMANT_CLIENT.id, warehouses_released: 0, history: { orders: 0 } } });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /permanently delete user/i })).toBeNull(),
    );
  });

  it('never offers Delete for a manager who is still active', async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValue({
      data: [{ ...DORMANT_MANAGER, id: 7, name: 'Rita Running', is_active: true }],
      meta: { page: 1, limit: 20, total: 1 },
    });

    renderUsers();
    await screen.findByText('Rita Running');

    expect(screen.queryByLabelText('Permanently delete Rita Running')).toBeNull();
    expect(within(rowOf('Rita Running')).getByRole('button', { name: /deactivate/i })).toBeInTheDocument();
    // The only destructive affordance on the row is Deactivate.
    expect(within(rowOf('Rita Running')).queryByRole('button', { name: /^delete$/i })).toBeNull();
    expect(user).toBeDefined();
  });

  /*
   * Staff parity. These mirror the Client/Manager tests above rather than
   * introducing a second workflow: same row, same dialog, same endpoint.
   */
  describe('staff users', () => {
    it('deletes a deactivated staff user through the same dialog', async () => {
      const user = userEvent.setup();
      renderUsers();
      await screen.findByText('Sam Staff');

      const before = screen.getByText(/accounts\. Only administrators can change roles/).textContent;
      const dialog = await openDeleteDialog(user, 'Sam Staff');

      // The dialog reports the role that is actually being removed.
      expect(within(dialog).getByText('Sam Staff')).toBeInTheDocument();
      expect(within(dialog).getByText('sam@stockpulse.test')).toBeInTheDocument();
      expect(within(dialog).getByText('Staff')).toBeInTheDocument();
      expect(within(dialog).getByText('This cannot be undone')).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Permanently Delete' }));

      await waitFor(() => expect(api.remove).toHaveBeenCalledWith(DORMANT_STAFF.id));
      await waitFor(() => expect(screen.queryByText('Sam Staff')).toBeNull());

      // Count follows the row out, and the same success toast is used.
      expect(screen.getByText('User permanently deleted')).toBeInTheDocument();
      const after = screen.getByText(/accounts\. Only administrators can change roles/).textContent;
      expect(after).not.toEqual(before);

      // Colleagues with the other roles are untouched.
      expect(screen.getByText('Dina Dormant')).toBeInTheDocument();
      expect(screen.getByText('Mo Manager')).toBeInTheDocument();
    });

    it('shows Deactivate and no Delete while a staff user is active', async () => {
      api.list.mockResolvedValue({
        data: [{ ...DORMANT_STAFF, id: 7, name: 'Rita Running', is_active: true }],
        meta: { page: 1, limit: 20, total: 1 },
      });

      renderUsers();
      await screen.findByText('Rita Running');

      const row = rowOf('Rita Running');
      expect(within(row).getByRole('button', { name: /deactivate/i })).toBeInTheDocument();
      expect(screen.queryByLabelText('Permanently delete Rita Running')).toBeNull();
      expect(within(row).queryByRole('button', { name: /^delete$/i })).toBeNull();
    });

    it('hides Delete again once a staff user is reactivated', async () => {
      const user = userEvent.setup();
      renderUsers();
      await screen.findByText('Sam Staff');

      // Deactivated: Delete is offered.
      expect(screen.getByLabelText('Permanently delete Sam Staff')).toBeInTheDocument();

      await user.click(within(rowOf('Sam Staff')).getByRole('button', { name: /reactivate/i }));

      await waitFor(() => expect(api.update).toHaveBeenCalledWith(DORMANT_STAFF.id, { is_active: true }));
      await waitFor(() =>
        expect(screen.queryByLabelText('Permanently delete Sam Staff')).toBeNull(),
      );

      // And the ordinary Deactivate action is back.
      const row = rowOf('Sam Staff');
      expect(within(row).getByRole('button', { name: /^deactivate$/i })).toBeInTheDocument();
      // The row keeps its role after coming back.
      expect(within(row).getByText('Staff')).toBeInTheDocument();
    });
  });
});