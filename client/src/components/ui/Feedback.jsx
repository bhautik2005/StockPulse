import { AlertTriangle, Inbox, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';

import { cn } from '../../lib/utils.js';
import { Button } from './Button.jsx';

export function Spinner({ className }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-muted-foreground', className)} aria-hidden="true" />;
}

export function Skeleton({ className, ...props }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

/** Placeholder rows sized like the table they stand in for, so nothing jumps. */
export function TableSkeleton({ rows = 5, columns = 5 }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4 px-3 py-2.5">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={cn('h-4', columnIndex === 0 ? 'w-40' : 'w-24', columnIndex === columns - 1 && 'ml-auto')}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Alert({ tone = 'info', title, children, className, action }) {
  const tones = {
    info: 'border-border bg-muted/50',
    warning: 'border-warning/40 bg-warning/10',
    destructive: 'border-destructive/40 bg-destructive/10',
    success: 'border-success/40 bg-success/10',
  };
  const icons = {
    info: ShieldAlert,
    warning: AlertTriangle,
    destructive: AlertTriangle,
    success: Inbox,
  };
  const Icon = icons[tone] ?? ShieldAlert;

  return (
    <div role="alert" className={cn('flex items-start gap-3 rounded-md border p-3 text-sm', tones[tone], className)}>
      <Icon
        className={cn('mt-0.5 h-4 w-4 shrink-0', {
          'text-warning': tone === 'warning',
          'text-destructive': tone === 'destructive',
          'text-success': tone === 'success',
          'text-muted-foreground': tone === 'info',
        })}
        aria-hidden="true"
      />
      <div className="flex flex-1 flex-col gap-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-xs text-muted-foreground">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-14 text-center', className)}>
      <div className="rounded-full border border-border bg-muted/50 p-3">
        <Icon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="max-w-sm text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

/**
 * Rendered when a request fails. Shows the error's own message and code -- the
 * API is specific about what went wrong, and hiding that behind "an error
 * occurred" wastes the work that went into producing it.
 */
export function ErrorState({ error, onRetry, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      <div className="rounded-full border border-destructive/40 bg-destructive/10 p-3">
        <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Could not load this data</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {error?.message ?? 'Unexpected error'}
          {error?.code ? <span className="ml-1 font-mono text-2xs opacity-70">({error.code})</span> : null}
        </p>
        {error?.requestId ? (
          <p className="font-mono text-2xs text-muted-foreground/70">request {error.requestId}</p>
        ) : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}