import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '../../lib/utils.js';

const VARIANTS = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline: 'border border-input bg-transparent hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm',
  success: 'bg-success text-success-foreground hover:bg-success/90 shadow-sm',
  link: 'text-primary underline-offset-4 hover:underline',
};

const SIZES = {
  sm: 'h-8 px-3 text-xs',
  default: 'h-9 px-4 text-sm',
  lg: 'h-10 px-6 text-sm',
  icon: 'h-9 w-9',
};

export const Button = forwardRef(function Button(
  { className, variant = 'default', size = 'default', loading = false, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // A button that is mid-request must not be clickable again: for "Place
      // order" that is the difference between one order and two.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'focus-ring inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
});