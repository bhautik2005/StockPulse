/**
 * Endpoint wrappers, one per domain.
 *
 * Pages import these instead of building paths, so a URL exists in exactly one
 * place and a shape change is a one-line edit. Each function returns the parsed
 * payload as the API sends it: `{ data, meta }` for lists, `{ data }` for a
 * single record.
 */
import { api } from './api.js';

export const authApi = {
  login: (credentials) => api.post('/api/auth/login', credentials),
  register: (details) => api.post('/api/auth/register', details),
  me: () => api.get('/api/auth/me'),
  /** `all` also bumps token_version, revoking every other session. */
  logout: (all = false) => api.post('/api/auth/logout', undefined, { query: { all } }),
};

export const usersApi = {
  list: (params) => api.get('/api/users', { query: params }),
  create: (user) => api.post('/api/users', user),
  update: (id, changes) => api.patch(`/api/users/${id}`, changes),
  setWarehouseAccess: (id, { grant = [], revoke = [] }) =>
    api.post(`/api/users/${id}/warehouse-access`, { grant, revoke }),
};

export const warehousesApi = {
  list: (params) => api.get('/api/warehouses', { query: params }),
  get: (id) => api.get(`/api/warehouses/${id}`),
  create: (warehouse) => api.post('/api/warehouses', warehouse),
  update: (id, changes) => api.patch(`/api/warehouses/${id}`, changes),
  inventory: (id, params) => api.get(`/api/warehouses/${id}/inventory`, { query: params }),
  ledger: (id, params) => api.get(`/api/warehouses/${id}/ledger`, { query: params }),
  orders: (id, params) => api.get(`/api/warehouses/${id}/orders`, { query: params }),
};

export const productsApi = {
  list: (params) => api.get('/api/products', { query: params }),
  create: (product) => api.post('/api/products', product),
  update: (id, changes) => api.patch(`/api/products/${id}`, changes),
  bulkImport: (formData) => api.post('/api/products/bulk-import', formData),
  /** Soft delete: the product is archived, never removed. */
  archive: (id) => api.delete(`/api/products/${id}`),
};

export const catalogApi = {
  /** Client-facing: aggregate availability only, never a warehouse breakdown. */
  list: (params) => api.get('/api/catalog', { query: params }),
  get: (id) => api.get(`/api/catalog/${id}`),
};

export const inventoryApi = {
  list: (params) => api.get('/api/inventory', { query: params }),
  lowStock: (params) => api.get('/api/inventory/low-stock', { query: params }),
  ledger: (params) => api.get('/api/inventory/ledger', { query: params }),
  adjust: (adjustment) => api.post('/api/inventory/adjust', adjustment),
};

export const ordersApi = {
  list: (params) => api.get('/api/orders', { query: params }),
  get: (id) => api.get(`/api/orders/${id}`),
  /**
   * `idempotencyKey` makes a retry safe: if the first attempt actually landed,
   * the server replies 200 with the existing order instead of creating a second.
   */
  create: (order, idempotencyKey) =>
    api.post('/api/orders', order, { idempotencyKey }),
  cancel: (id, reason) => api.post(`/api/orders/${id}/cancel`, { reason }),
  updateStatus: (id, status, reason) =>
    api.patch(`/api/orders/${id}/status`, reason ? { status, reason } : { status }),
  /**
   * Bulk import orders from a FormData payload containing a .csv or .xlsx
   * file. Pass an `idempotencyKey` UUID to make retries safe.
   */
  bulkImport: (formData, idempotencyKey) =>
    api.post('/api/orders/bulk-import', formData, { idempotencyKey }),
};

export const analyticsApi = {
  summary: () => api.get('/api/analytics/summary'),
  salesTrend: (days = 30) => api.get('/api/analytics/sales-trend', { query: { days } }),
  topProducts: (limit = 5) => api.get('/api/analytics/top-products', { query: { limit } }),
  byWarehouse: () => api.get('/api/analytics/by-warehouse'),
};