import { useEffect, useRef, useState } from 'react';

import { cn } from '../../lib/utils.js';

/**
 * A small menu anchored to its trigger. Closes on outside click, Escape, or
 * selection -- the three ways a person expects to dismiss one.
 */
export function DropdownMenu({ trigger, children, align = 'right', className }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <div onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open}>
        {trigger}
      </div>

      {open ? (
        <div
          role="menu"
          className={cn(
            'absolute z-40 mt-1 min-w-[11rem] overflow-hidden rounded-md border border-border bg-popover p-1 shadow-lg animate-scale-in',
            align === 'right' ? 'right-0' : 'left-0',
            className,
          )}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function DropdownItem({ className, destructive = false, ...props }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-ring ',
        destructive && 'text-destructive hover:bg-destructive/10',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownSeparator() {
  return <div className="my-1 h-px bg-border" role="separator" />;
}

export function DropdownLabel({ className, ...props }) {
  return (
    <div
      className={cn('px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground', className)}
      {...props}
    />
  );
}