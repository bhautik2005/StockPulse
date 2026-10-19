import { cn } from '../../lib/utils.js';

/**
 * Tab strip used for status filters. `tabs` is [{ value, label, count }]; a
 * count is shown when the caller has one, because "Shipped (12)" answers the
 * question the user was about to ask by clicking it.
 */
export function Tabs({ value, onValueChange, tabs, className }) {
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
              active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
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