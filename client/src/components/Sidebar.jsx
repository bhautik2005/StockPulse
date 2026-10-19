import { NavLink } from 'react-router-dom';
import {
  Boxes,
  LayoutDashboard,
  Package,
  ShoppingCart,
  Users,
  Warehouse,
  X,
  Zap,
} from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { INTERNAL_ROLES, ROLES, canManageCatalogue } from '../lib/constants.js';
import { cn } from '../lib/utils.js';

/**
 * Navigation is derived from the signed-in role, not hidden after the fact.
 *
 * A Client genuinely cannot call /api/inventory or /api/analytics -- the server
 * answers 403 -- so offering the links would be a promise the product cannot
 * keep. Declaring `roles` per entry means the menu and the API agree.
 */
function navItemsFor(role) {
  const items = [
    {
      to: '/dashboard',
      label: 'Dashboard',
      icon: LayoutDashboard,
      roles: INTERNAL_ROLES,
    },
    {
      to: '/warehouses',
      label: 'Warehouses',
      icon: Warehouse,
      roles: INTERNAL_ROLES,
    },
    {
      to: '/inventory',
      label: 'Inventory',
      icon: Boxes,
      roles: INTERNAL_ROLES,
    },
    {
      to: '/products',
      // The same page serves three audiences: full catalogue management for
      // Admin/Manager, the read-only internal catalogue for Staff, and the
      // client-facing catalogue for Clients.
      label: canManageCatalogue(role) ? 'Products' : 'Catalogue',
      icon: Package,
      roles: [ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF, ROLES.CLIENT],
    },
    {
      to: '/orders',
      label: role === ROLES.CLIENT ? 'My Orders' : 'Orders',
      icon: ShoppingCart,
      roles: [ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF, ROLES.CLIENT],
    },
    {
      to: '/users',
      label: 'Users',
      icon: Users,
      roles: [ROLES.ADMIN],
    },
  ];

  return items.filter((item) => item.roles.includes(role));
}

export function Sidebar({ open, onClose }) {
  const { user, hasGlobalScope, scopeIds } = useAuth();
  const items = navItemsFor(user?.role);

  return (
    <>
      {/* Mobile scrim */}
      {open ? (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-border bg-card transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-border px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Zap className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="flex flex-col leading-none">
              <span className="text-sm font-semibold tracking-tight">StockPulse</span>
              <span className="text-2xs text-muted-foreground">Operations console</span>
            </div>
          </div>
          <button
            type="button"
            className="focus-ring rounded text-muted-foreground lg:hidden"
            onClick={onClose}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2" aria-label="Main navigation">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'focus-ring flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/*
          The scope line answers the question every scoped user has: "am I seeing
          everything, or only my warehouses?" Leaving that ambiguous is how
          someone misreads a total.
        */}
        <div className="border-t border-border p-3">
          <p className="text-2xs uppercase tracking-wide text-muted-foreground">Data scope</p>
          <p className="mt-0.5 text-xs">
            {hasGlobalScope ? (
              <span className="text-foreground">All warehouses</span>
            ) : scopeIds.length > 0 ? (
              <span className="text-foreground">
                {scopeIds.length} assigned {scopeIds.length === 1 ? 'warehouse' : 'warehouses'}
              </span>
            ) : user?.role === ROLES.CLIENT ? (
              <span className="text-muted-foreground">Your own orders</span>
            ) : (
              <span className="text-warning">No warehouses assigned</span>
            )}
          </p>
          {user?.warehouses?.length ? (
            <p className="mt-1 truncate text-2xs text-muted-foreground" title={user.warehouses.map((w) => w.name).join(', ')}>
              {user.warehouses.map((w) => w.code).join(' · ')}
            </p>
          ) : null}
        </div>
      </aside>
    </>
  );
}