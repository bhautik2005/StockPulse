import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle, ChevronDown, LogOut, Menu, ShieldCheck } from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { INTERNAL_ROLES, ROLES } from '../lib/constants.js';
import { initialsOf } from '../lib/format.js';
import { inventoryApi } from '../services/endpoints.js';
import { cn } from '../lib/utils.js';
import { Badge } from './ui/Badge.jsx';
import { Button } from './ui/Button.jsx';
import { DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator } from './ui/DropdownMenu.jsx';
import { ThemeToggle } from './ThemeToggle.jsx';

const TITLES = {
  '/dashboard': 'Dashboard',
  '/warehouses': 'Warehouses',
  '/inventory': 'Inventory',
  '/products': 'Products',
  '/orders': 'Orders',
  '/users': 'Users',
};

const ROLE_TONE = {
  [ROLES.ADMIN]: 'destructive',
  [ROLES.MANAGER]: 'primary',
  [ROLES.STAFF]: 'info',
  [ROLES.CLIENT]: 'default',
};

export function Navbar({ onMenuClick }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [lowStock, setLowStock] = useState(null);

  const isInternal = INTERNAL_ROLES.includes(user?.role);

  useEffect(() => {
    if (!isInternal) return undefined;
    let cancelled = false;

    // limit=1: only the count is needed, meta.total returns the exact total count
    inventoryApi
      .list({ low_stock: 'true', limit: 1 })
      .then((payload) => {
        if (!cancelled) setLowStock(payload?.meta?.total ?? 0);
      })
      .catch(() => {
        // A failed badge must never break the page around it.
        if (!cancelled) setLowStock(null);
      });

    return () => {
      cancelled = true;
    };
  }, [isInternal, location.pathname]);

  const title =
    TITLES[location.pathname] ??
    (user?.role === ROLES.CLIENT && location.pathname === '/products' ? 'Catalogue' : 'StockPulse');

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenuClick} aria-label="Open navigation">
        <Menu className="h-4 w-4" />
      </Button>

      <h1 className="text-sm font-semibold">{title}</h1>

      <div className="ml-auto flex items-center gap-1.5">
        {isInternal && lowStock !== null && lowStock > 0 ? (
          <Link
            to="/inventory?low_stock=true"
            className={cn(
              'focus-ring flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-2xs font-medium text-warning transition-colors hover:bg-warning/20',
            )}
            title={`${lowStock} stock lines at or below their reorder level`}
          >
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="tabular">{lowStock}</span>
            <span className="hidden sm:inline">low stock</span>
          </Link>
        ) : null}

        <ThemeToggle />

        <DropdownMenu
          trigger={
            <Button variant="ghost" className="gap-2 px-2" aria-label="Account menu">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-2xs font-semibold text-primary">
                {initialsOf(user?.name) || '?'}
              </span>
              <span className="hidden max-w-[9rem] truncate text-xs sm:inline">{user?.name}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            </Button>
          }
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-xs font-medium">{user?.name}</p>
            <p className="truncate text-2xs text-muted-foreground">{user?.email}</p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <Badge tone={ROLE_TONE[user?.role] ?? 'default'}>
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                {user?.role}
              </Badge>
            </div>
          </div>

          <DropdownSeparator />
          <DropdownLabel>Session</DropdownLabel>

          <DropdownItem onClick={() => logout()}>
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </DropdownItem>

          {/*
            Revokes every token for this account, including other devices. The
            server bumps token_version, so an already-issued JWT stops working
            immediately rather than at expiry.
          */}
          <DropdownItem onClick={() => logout({ all: true })}>
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out everywhere
          </DropdownItem>
        </DropdownMenu>
      </div>
    </header>
  );
}