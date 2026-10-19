import { cn } from '../../lib/utils.js';

const TONES = {
  default: 'border-transparent bg-secondary text-secondary-foreground',
  primary: 'border-transparent bg-primary/15 text-primary',
  success: 'border-transparent bg-success/15 text-success',
  warning: 'border-transparent bg-warning/15 text-warning',
  destructive: 'border-transparent bg-destructive/15 text-destructive',
  info: 'border-transparent bg-primary/15 text-primary',
  outline: 'border-border text-muted-foreground',
};

export function Badge({ className, tone = 'default', children, ...props }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium',
        TONES[tone] ?? TONES.default,
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/**
 * Order status badge. The colour is decided once, here, so "Pending" is the
 * same amber everywhere in the product.
 */
export function StatusBadge({ status, className }) {
  const tone =
    {
      Pending: 'warning',
      Processing: 'info',
      'Partially Shipped': 'info',
      Shipped: 'primary',
      Delivered: 'success',
      Cancelled: 'destructive',
    }[status] ?? 'default';

  return (
    <Badge tone={tone} className={className}>
      <span
        className={cn('h-1.5 w-1.5 rounded-full', {
          'bg-warning': tone === 'warning',
          'bg-primary': tone === 'info' || tone === 'primary',
          'bg-success': tone === 'success',
          'bg-destructive': tone === 'destructive',
          'bg-muted-foreground': tone === 'default',
        })}
        aria-hidden="true"
      />
      {status}
    </Badge>
  );
}