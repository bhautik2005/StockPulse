import { cn } from '../../lib/utils.js';

/**
 * Tab strip used for status filters and for the product category rail.
 *
 * `tabs` is [{ value, label, count }]; a count is shown when the caller has one,
 * because "Shipped (12)" answers the question the user was about to ask by
 * clicking it.
 *
 * Every tab is always rendered -- the component never decides to show only the
 * selected one. Callers that need the list to stay stable while the data behind
 * it is filtered must supply the full list; that is what keeps a filter from
 * removing the control needed to undo it.
 *
 * `variant`:
 *   - 'pill'   (default) the original flat style, used by the order status strip
 *   - 'filter' draws an outline on every tab and a tinted background + border on
 *              the active one, which reads as a clearly selected filter
 */
const VARIANT_CLASSES = {
  pill: {
    base: '',
    active: 'bg-accent text-foreground',
    inactive: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
  },
  filter: {
    // The transparent border on inactive tabs is not decoration: it reserves the
    // same 1px so selecting a category does not make the strip jump.
    base: 'border',
    active: 'border-primary/50 bg-primary/15 text-foreground',
    inactive: 'border-border/60 text-muted-foreground hover:bg-accent/50 hover:text-foreground',
  },
};

export function Tabs({ value, onValueChange, tabs, className, variant = 'pill' }) {
  const styles = VARIANT_CLASSES[variant] ?? VARIANT_CLASSES.pill;

  return (
    <div role="tablist" className={cn('flex items-center gap-1 overflow-x-auto', className)}>
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onValueChange(tab.value)}
            className={cn(
              'focus-ring relative whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              styles.base,
              active ? styles.active : styles.inactive,
            )}
          >
            {tab.label}
            {tab.count !== undefined && tab.count !== null ? (
              <span className={cn('tabular ml-1.5 text-2xs', active ? 'text-foreground/70' : 'text-muted-foreground/70')}>
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
