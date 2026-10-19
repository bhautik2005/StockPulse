import { forwardRef, useId } from 'react';

import { cn } from '../../lib/utils.js';

const FIELD =
  'focus-ring flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50';

export const Input = forwardRef(function Input({ className, type = 'text', ...props }, ref) {
  return <input ref={ref} type={type} className={cn(FIELD, className)} {...props} />;
});

export const Textarea = forwardRef(function Textarea({ className, rows = 3, ...props }, ref) {
  return <textarea ref={ref} rows={rows} className={cn(FIELD, 'h-auto py-2', className)} {...props} />;
});

export const Select = forwardRef(function Select({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(FIELD, 'cursor-pointer pr-8 bg-background', className)} {...props}>
      {children}
    </select>
  );
});

export function Label({ className, children, htmlFor, ...props }) {
  return (
    <label htmlFor={htmlFor} className={cn('text-xs font-medium text-muted-foreground', className)} {...props}>
      {children}
    </label>
  );
}

/**
 * Label + control + error, wired together with a generated id so the error is
 * announced rather than merely displayed next to the field.
 */
export function Field({ label, error, hint, required, className, children }) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? (
        <Label htmlFor={id}>
          {label}
          {required ? <span className="ml-0.5 text-destructive">*</span> : null}
        </Label>
      ) : null}
      {typeof children === 'function'
        ? children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': error ? errorId : undefined })
        : children}
      {error ? (
        <p id={errorId} className="text-2xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-2xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}