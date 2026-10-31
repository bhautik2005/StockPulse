/**
 * Phase 3 :: Products -- category filter rail.
 *
 * The regression being guarded is specific: the rail must be rendered from the
 * catalogue's full taxonomy, not from the rows currently on screen. When it was
 * derived from `rows`, selecting a category replaced the list with that single
 * category, so every other button vanished -- including the one needed to undo
 * the selection.
 *
 * The stub below therefore mimics the real API contract: it filters `data` by
 * category/search but always returns the COMPLETE category list in `meta`,
 * independent of those filters. If the page ever goes back to deriving the rail
 * from the returned rows, the "keeps every button" assertions fail.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../../client/src/components/ui/Toast.jsx';
import { AuthProvider } from '../../../client/src/context/AuthContext.jsx';
import { Products } from '../../../client/src/pages/Products.jsx';

const api = vi.hoisted(() => ({ me: vi.fn(), list: vi.fn(), listCatalog: vi.fn() }));

vi.mock('../../../client/src/services/endpoints.js', () => ({
  authApi: { me: api.me },
  productsApi: { list: api.list, create: vi.fn(), update: vi.fn(), archive: vi.fn() },
  catalogApi: { list: api.listCatalog },
}));

const CATEGORIES = [
  'Displays',
  'Electrical',
  'Fittings',
  'Networking',
  'Pneumatics',
  'Safety',
  'Storage',
  'Tools',
  'Valves',
];

function product(id, sku, name, category, isActive = true) {
  return {
    id,
    sku,
    name,
    category,
    unit_price: '10.00',
    reorder_level: 1,
    total_quantity: 3,
    is_active: isActive,
  };
}

const PRODUCTS = [
  product(1, 'FIT-1', 'Elbow joint', 'Fittings'),
  product(2, 'FIT-2', 'Pipe clamp', 'Fittings'),
  product(3, 'TLS-1', 'Torque wrench', 'Tools'),
  product(4, 'DSP-1', 'LED panel', 'Displays'),
  product(5, 'TLS-2', 'Retired spanner', 'Tools', false),
];

function ProductRoute() {
  const location = useLocation();
  return (
    <>
      <Products />
      <output data-testid="location-search">{location.search}</output>
    </>
  );
}

function renderProducts(route = '/products') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="*" element={<ProductRoute />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Every tab in the category rail, including "All categories". */
const railTabs = () => within(screen.getByRole('tablist')).getAllByRole('tab');

const tab = (name) => within(screen.getByRole('tablist')).getByRole('tab', { name });

describe('Phase 3 :: Products -- category rail', () => {
  beforeEach(() => {
    api.me.mockResolvedValue({
      data: { id: 1, name: 'Product Admin', role: 'Admin', scope: { all: true, ids: null } },
    });

    api.list.mockImplementation(({ category, search, include_inactive } = {}) => {
      const withArchived = include_inactive === 'true';
      let rows = PRODUCTS.filter((p) => withArchived || p.is_active);
      if (category) rows = rows.filter((p) => p.category === category);
      if (search) {
        const needle = search.toLowerCase();
        rows = rows.filter((p) => `${p.sku} ${p.name}`.toLowerCase().includes(needle));
      }
      // The taxonomy does not depend on the active search or category. The
      // fixture below only populates three of the categories, which is exactly
      // the point: the rail must still offer all nine.
      return Promise.resolve({
        data: rows,
        meta: { page: 1, limit: 20, total: rows.length, categories: CATEGORIES },
      });
    });

    api.listCatalog.mockResolvedValue({
      data: [],
      meta: { page: 1, limit: 20, total: 0, categories: [] },
    });
  });

  it('renders every category up front with All categories highlighted', async () => {
    renderProducts();
    await screen.findByText('Elbow joint');

    expect(railTabs()).toHaveLength(CATEGORIES.length + 1);
    for (const name of CATEGORIES) expect(tab(name)).toBeInTheDocument();
    expect(tab('All categories')).toHaveAttribute('aria-selected', 'true');
    // Default state shows products from every category.
    expect(screen.getByText('Elbow joint')).toBeInTheDocument();
    expect(screen.getByText('Torque wrench')).toBeInTheDocument();
    expect(screen.getByText('LED panel')).toBeInTheDocument();
  });

  it('keeps every category visible when one is selected, and highlights only it', async () => {
    const user = userEvent.setup();
    renderProducts();
    await screen.findByText('Elbow joint');

    await user.click(tab('Fittings'));

    // 3. every other option is still on screen -- this is the regression.
    expect(railTabs()).toHaveLength(CATEGORIES.length + 1);
    for (const name of CATEGORIES) expect(tab(name)).toBeInTheDocument();

    // 2. only the selected category is highlighted.
    expect(tab('Fittings')).toHaveAttribute('aria-selected', 'true');
    expect(tab('All categories')).toHaveAttribute('aria-selected', 'false');
    expect(railTabs().filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);

    // The selected filter is carried in the URL, so a refresh restores it.
    expect(screen.getByTestId('location-search').textContent).toContain('category=Fittings');
  });

  it('filters the products and the count down to the selected category', async () => {
    const user = userEvent.setup();
    renderProducts();
    await screen.findByText('Elbow joint');

    await user.click(tab('Fittings'));

    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'Fittings' })));
    expect(await screen.findByText('Elbow joint')).toBeInTheDocument();
    expect(screen.getByText('Pipe clamp')).toBeInTheDocument();
    expect(screen.queryByText('Torque wrench')).toBeNull();
    expect(screen.queryByText('LED panel')).toBeNull();
    expect(screen.getByText('2 active products match the current filters.')).toBeInTheDocument();
  });

  it('restores every product when All categories is selected again', async () => {
    const user = userEvent.setup();
    renderProducts();
    await screen.findByText('Elbow joint');

    await user.click(tab('Fittings'));
    expect(await screen.findByText('2 active products match the current filters.')).toBeInTheDocument();

    await user.click(tab('All categories'));

    expect(await screen.findByText('Torque wrench')).toBeInTheDocument();
    expect(screen.getByText('LED panel')).toBeInTheDocument();
    expect(tab('All categories')).toHaveAttribute('aria-selected', 'true');
    expect(railTabs()).toHaveLength(CATEGORIES.length + 1);
    expect(screen.getByText('4 active products match the current filters.')).toBeInTheDocument();
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ category: undefined }));
  });

  it('keeps the rail stable while searching, and composes with Include archived', async () => {
    const user = userEvent.setup();
    renderProducts();
    await screen.findByText('Elbow joint');

    // A search that matches nothing must not clear the rail: the buttons are the
    // only way back to a wider view.
    await user.type(screen.getByLabelText('Search products'), 'zzz-no-match');
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'zzz-no-match' })));
    expect(railTabs()).toHaveLength(CATEGORIES.length + 1);

    await user.clear(screen.getByLabelText('Search products'));
    await screen.findByText('Elbow joint');

    // Search + category + archive all in play at once.
    await user.click(tab('Tools'));
    await user.click(screen.getByRole('button', { name: /Include archived/i }));

    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ category: 'Tools', include_inactive: 'true' }),
      ),
    );
    expect(await screen.findByText('Torque wrench')).toBeInTheDocument();
    expect(screen.getByText('Retired spanner')).toBeInTheDocument();
    // The archived row is visually distinct and labelled.
    expect(screen.getByText('Retired spanner').closest('tr').classList.contains('bg-muted/40')).toBe(true);
    expect(screen.getByText('Archived')).toBeInTheDocument();
    // The rail is untouched by any of it.
    expect(railTabs()).toHaveLength(CATEGORIES.length + 1);
  });

  it('restores the category from the URL and outlines the active filter', async () => {
    renderProducts('/products?category=Tools&search=wrench');

    expect(await screen.findByText('Torque wrench')).toBeInTheDocument();
    expect(tab('Tools')).toHaveAttribute('aria-selected', 'true');
    expect(railTabs()).toHaveLength(CATEGORIES.length + 1);
    // The active filter carries a border as well as a background.
    expect(tab('Tools').className).toMatch(/border-primary/);
    expect(tab('Fittings').className).not.toMatch(/border-primary/);
  });
});
