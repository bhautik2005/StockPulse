import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';

import { cn } from '../lib/utils.js';
import { Card } from './ui/Card.jsx';
import { Skeleton } from './ui/Feedback.jsx';

/**
 * A headline metric.
 *
 * `value` is expected pre-formatted (formatMoney / formatNumber) because money
 * arrives from the API as an exact decimal string and is never re-derived here.
 */
export function StatCard({ label, value, hint, icon: Icon, trend, loading = false, tone = 'default', className }) {
  const TrendIcon = trend?.direction === 'up' ? ArrowUpRight : trend?.direction === 'down' ? ArrowDownRight : Minus;

  return (
    <Card className={cn('p-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon ? (
          <div
            className={cn('rounded-md border border-border p-1.5', {
              'bg-primary/10 text-primary': tone === 'primary',
              'bg-warning/10 text-warning': tone === 'warning',
              'bg-destructive/10 text-destructive': tone === 'destructive',
              'bg-success/10 text-success': tone === 'success',
              'bg-muted text-muted-foreground': tone === 'default',
            })}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </div>
        ) : null}
      </div>

      {loading ? (
        <Skeleton className="mt-3 h-7 w-28" />
      ) : (
        <p className="tabular mt-2 text-xl font-semibold tracking-tight">{value}</p>
      )}

      <div className="mt-1.5 flex items-center gap-1.5">
        {trend && !loading ? (
          <span
            className={cn('inline-flex items-center gap-0.5 text-2xs font-medium', {
              'text-success': trend.direction === 'up',
              'text-destructive': trend.direction === 'down',
              'text-muted-foreground': trend.direction === 'flat',
            })}
          >
            <TrendIcon className="h-3 w-3" aria-hidden="true" />
            {trend.label}
          </span>
        ) : null}
        {hint ? <span className="text-2xs text-muted-foreground">{hint}</span> : null}
      </div>
    </Card>
  );
}