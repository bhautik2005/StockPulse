import { Outlet } from 'react-router-dom';
import { Boxes, ShieldCheck, TrendingUp, Truck } from 'lucide-react';

const HIGHLIGHTS = [
  { icon: Boxes, title: 'Multi-warehouse stock', body: 'Per-warehouse quantities, thresholds and valuations.' },
  { icon: Truck, title: 'Atomic fulfilment', body: 'An order succeeds completely, or not at all.' },
  { icon: TrendingUp, title: 'Live analytics', body: 'Revenue, trends and low-stock exposure per warehouse.' },
  { icon: ShieldCheck, title: 'Scoped access', body: 'Managers see their warehouses; clients see their orders.' },
];

/**
 * Split-screen entry point: brand and capability summary on one side, the form
 * on the other. On narrow screens the panel collapses so the form stays above
 * the fold.
 */
export function AuthLayout() {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-card p-10 lg:flex">
        {/* A faint grid, for the operations-console feel, without an image asset. */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.15]"
          style={{
            backgroundImage:
              'linear-gradient(hsl(var(--border)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -left-24 top-1/3 h-72 w-72 rounded-full bg-primary/20 blur-3xl"
          aria-hidden="true"
        />

        <div className="relative flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Boxes className="h-4 w-4" aria-hidden="true" />
          </div>
          <span className="text-base font-semibold tracking-tight">StockPulse</span>
        </div>

        <div className="relative flex max-w-md flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">
              Inventory that cannot be oversold.
            </h2>
            <p className="text-sm text-muted-foreground">
              Stock movements are guarded in the database itself, so two simultaneous orders can
              never claim the same last unit.
            </p>
          </div>

          <ul className="flex flex-col gap-3">
            {HIGHLIGHTS.map((item) => (
              <li key={item.title} className="flex items-start gap-3">
                <div className="mt-0.5 rounded-md border border-border bg-background/60 p-1.5">
                  <item.icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-xs font-medium">{item.title}</p>
                  <p className="text-2xs text-muted-foreground">{item.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-2xs text-muted-foreground">
          PostgreSQL · exact decimal money · append-only stock ledger
        </p>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <Outlet />
        </div>
      </div>
    </div>
  );
}