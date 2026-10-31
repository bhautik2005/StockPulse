import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../../client/src/context/AuthContext.jsx';
import { ToastProvider } from '../../../client/src/components/ui/Toast.jsx';
import { Orders } from '../../../client/src/pages/Orders.jsx';

const api = vi.hoisted(() => ({
  me: vi.fn(),
  listOrders: vi.fn(),
  createOrder: vi.fn(),
  getOrder: vi.fn(),
  listWarehouses: vi.fn(),
  listProducts: vi.fn(),
  listCatalog: vi.fn(),
}));

vi.mock('../../../client/src/services/endpoints.js', () => ({
  authApi: { me: api.me },
  ordersApi: {
    list: api.listOrders,
    create: api.createOrder,
    get: api.getOrder,
    cancel: vi.fn(),
    updateStatus: vi.fn(),
    bulkImport: vi.fn(),
  },
  warehousesApi: { list: api.listWarehouses },
  productsApi: { list: api.listProducts },
  catalogApi: { list: api.listCatalog },
  inventoryApi: { list: vi.fn(), adjust: vi.fn() },
}));

describe('Manager Orders page', () => {
  beforeEach(() => {
    api.me.mockResolvedValue({
      data: {
        id: 12,
        name: 'Branch Manager',
        role: 'Manager',
        scope: { all: false, ids: [42] },
      },
    });
    api.listOrders.mockResolvedValue({ data: [], meta: { page: 1, limit: 20, total: 0 } });
    api.createOrder.mockResolvedValue({
      data: { id: 101, order_number: 'ORD-101', total_amount: '12.50', currency: 'USD' },
      meta: {},
    });
    api.getOrder.mockResolvedValue({ data: { id: 101, items: [] } });
    api.listWarehouses.mockResolvedValue({
      data: [{ id: 42, code: 'BR-42', name: 'Assigned branch' }],
      meta: { page: 1, limit: 100, total: 1 },
    });
    api.listProducts.mockResolvedValue({
      data: [{
        id: 8,
        sku: 'SCOPED-8',
        name: 'Scoped product',
        unit_price: '12.50',
        total_quantity: 5,
      }],
      meta: { page: 1, limit: 100, total: 1 },
    });
    api.listCatalog.mockResolvedValue({ data: [], meta: { page: 1, limit: 100, total: 0 } });
  });

  it('shows both order actions and submits the new order to the assigned warehouse', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/orders']}>
        <AuthProvider>
          <ToastProvider>
            <Routes>
              <Route path="*" element={<Orders />} />
            </Routes>
          </ToastProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findByRole('button', { name: /Bulk order/i });
    expect(document.getElementById('orders-new-trigger')).toBeInTheDocument();

    await waitFor(() => {
      expect(api.listOrders).toHaveBeenCalledWith(expect.objectContaining({ warehouse_id: '42' }));
    });

    await user.click(document.getElementById('orders-new-trigger'));
    await user.click(await screen.findByRole('button', { name: /Scoped product/ }));

    const warehouseSelect = screen.getByLabelText('Warehouse');
    expect(warehouseSelect).toHaveValue('42');
    expect(warehouseSelect).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Place order/i }));

    await waitFor(() => {
      expect(api.createOrder).toHaveBeenCalledWith(
        { items: [{ product_id: 8, quantity: 1, warehouse_id: 42 }] },
        expect.any(String),
      );
    });
  });
});
