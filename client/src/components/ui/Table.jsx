import { cn } from '../../lib/utils.js';

/**
 * Table primitives. Dense by default: an operations console is judged on how
 * many rows a person can scan at once, so padding is tight and numbers are
 * right-aligned with tabular figures.
 */
export function Table({ className, children, ...props }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full caption-bottom border-collapse text-sm', className)} {...props}>
        {children}
      </table>
    </div>
  );
}

export function THead({ className, ...props }) {
  return <thead className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...props} />;
}

export function TBody({ className, ...props }) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TR({ className, ...props }) {
  return (
    <tr
      className={cn('border-b border-border transition-colors hover:bg-accent/40', className)}
      {...props}
    />
  );
}

export function TH({ className, ...props }) {
  return (
    <th
      scope="col"
      className={cn(
        'h-9 whitespace-nowrap px-3 text-left align-middle text-2xs font-semibold uppercase tracking-wide text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function TD({ className, ...props }) {
  return <td className={cn('px-3 py-2 align-middle', className)} {...props} />;
}

/** A right-aligned numeric cell. */
export function TDNumeric({ className, ...props }) {
  return <TD className={cn('tabular text-right', className)} {...props} />;
}