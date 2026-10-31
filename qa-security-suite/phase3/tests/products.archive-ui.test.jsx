import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../../client/src/components/ui/Toast.jsx';
import { AuthProvider } from '../../../client/src/context/AuthContext.jsx';
import { Products } from '../../../client/src/pages/Products.jsx';

const api = vi.hoisted(() => ({
  me: vi.fn(),
  list: vi.fn(),
  listCatalog: vi.fn(),
}));

vi.mock('../../../client/src/services/endpoints.js', () => ({
  authApi: { me: api.me },
  productsApi: {
    list: api.list,
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
  },
  catalogApi: { list: api.listCatalog },
}));

const activeProduct = {
  id: 1,
  sku: 'ACTIVE-1',
  name: 'Active product',
  category: 'Components',
  unit_price: '10.00',
  reorder_level: 1,
  total_quantity: 5,
  is_active: true,
};

const archivedProduct = {
  ...activeProduct,
  id: 2,
  sku: 'ARCHIVED-2',
  name: 'Archived product',
  is_active: false,
};

function ProductRoute() {
  const location = useLocation();
  return (
    <>
      <Products />
      <output data-testid="location-search">{location.search}</output>
    </>
  );
}

describe('Products page archived filter', () => {
  beforeEach(() => {
    api.me.mockResolvedValue({
      data: {
        id: 7,
        name: 'Product Admin',
        role: 'Admin',
        scope: { all: true, ids: null },
      },
    });

    api.list.mockImplementation(({ include_inactive } = {}) => {
      const includeArchived = include_inactive === 'true';
      return Promise.resolve({
        data: includeArchived ? [activeProduct, archivedProduct] : [activeProduct],
        meta: {
          page: 1,
          limit: 20,
          total: includeArchived ? 2 : 1,
          categories: ['Components'],
        },
      });
    });
    api.listCatalog.mockResolvedValue({
      data: [],
      meta: { page: 1, limit: 20, total: 0, categories: [] },
    });
  });

  it('updates the list, total, URL, and archived-row appearance when toggled', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/products']}>
        <AuthProvider>
          <ToastProvider>
            <Routes>
              <Route path="*" element={<ProductRoute />} />
            </Routes>
          </ToastProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Active product')).not.toBeNull();
    expect(screen.getByText('1 active product matches the current filters.')).not.toBeNull();
    expect(screen.queryByText('Archived product')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Include archived/i }));

    expect(await screen.findByText('Archived product')).not.toBeNull();
    expect(screen.getByTestId('location-search').textContent).toContain('include_inactive=true');
    expect(screen.getByText('2 products match the current filters, including archived products.')).not.toBeNull();
    expect(screen.getByText('Archived')).not.toBeNull();
    expect(screen.getByText('Active')).not.toBeNull();
    expect(screen.getByText('Archived product').closest('tr').classList.contains('bg-muted/40')).toBe(true);
    await waitFor(() => {
      expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ include_inactive: 'true' }));
    });
  });

  it('restores Include Archived and filters after loading from the URL', async () => {
    render(
      <MemoryRouter initialEntries={['/products?include_inactive=true&search=Archived&category=Components&page=2']}>
        <AuthProvider>
          <ToastProvider>
            <Routes>
              <Route path="*" element={<ProductRoute />} />
            </Routes>
          </ToastProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Archived product')).not.toBeNull();
    expect(screen.getByLabelText('Search products').value).toBe('Archived');
    expect(
      screen.getByRole('button', { name: /Include archived/i }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({
        include_inactive: 'true',
        search: 'Archived',
        category: 'Components',
        page: 2,
      }),
    );
  });
});
