/**
 * Domain vocabulary, mirroring the server exactly.
 *
 * These strings are the contract with the API: `Pending`, `Partially Shipped`
 * and friends are what the database stores, so they are never prettified in
 * transit -- only in the label shown to a human.
 */

export const ROLES = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  STAFF: 'Staff',
  CLIENT: 'Client',
};

/** Roles that may see internal stock, warehouses and analytics. */
export const INTERNAL_ROLES = [ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF];

/**
 * Roles that may read the internal product list and change the catalogue.
 *
 * This is narrower than INTERNAL_ROLES and the difference matters: `/api/products`
 * is Admin/Manager only, so a Staff member browsing "Products" must be served by
 * `/api/catalog` instead. Getting this wrong is a guaranteed 403.
 */
export const CATALOGUE_MANAGER_ROLES = [ROLES.ADMIN, ROLES.MANAGER];

export function canManageCatalogue(role) {
  return CATALOGUE_MANAGER_ROLES.includes(role);
}

export const ORDER_STATUS = [
  'Pending',
  'Processing',
  'Partially Shipped',
  'Shipped',
  'Delivered',
  'Cancelled',
];

/**
 * Status presentation. `tone` maps onto the Badge variants so a status colour
 * is decided in exactly one place.
 */
export const STATUS_META = {
  Pending: { tone: 'warning', label: 'Pending' },
  Processing: { tone: 'info', label: 'Processing' },
  'Partially Shipped': { tone: 'info', label: 'Partially Shipped' },
  Shipped: { tone: 'primary', label: 'Shipped' },
  Delivered: { tone: 'success', label: 'Delivered' },
  Cancelled: { tone: 'destructive', label: 'Cancelled' },
};

/**
 * Legal status transitions, mirrored from orders.service.js.
 *
 * The server is the authority; this copy exists only to avoid offering a button
 * that is guaranteed to fail. Cancellation is absent by design: it goes through
 * its own endpoint because it also returns stock.
 */
export const ALLOWED_TRANSITIONS = {
  Pending: ['Processing', 'Partially Shipped', 'Shipped'],
  Processing: ['Partially Shipped', 'Shipped'],
  'Partially Shipped': ['Shipped', 'Delivered'],
  Shipped: ['Delivered'],
  Delivered: [],
  Cancelled: [],
};

export const LEDGER_REASON_META = {
  receipt: { label: 'Receipt', direction: 'in' },
  sale: { label: 'Sale', direction: 'out' },
  adjustment: { label: 'Adjustment', direction: 'both' },
  restock: { label: 'Returned to stock', direction: 'in' },
  return: { label: 'Customer return', direction: 'in' },
  transfer_in: { label: 'Transfer in', direction: 'in' },
  transfer_out: { label: 'Transfer out', direction: 'out' },
};

/**
 * Where each role lands after signing in.
 *
 * A Client has no dashboard to land on -- analytics and inventory answer 403
 * for that role -- so sending them "home" to the dashboard would mean a
 * guaranteed error page on every sign-in.
 */
export function homePathFor(role) {
  return role === ROLES.CLIENT ? '/products' : '/dashboard';
}