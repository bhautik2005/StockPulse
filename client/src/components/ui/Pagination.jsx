import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '../../lib/utils.js';
import { Button } from './Button.jsx';

/**
 * Server-side pagination. The API returns `meta: { page, limit, total }`, and
 * `limit` is capped at 100 by the server, so the page size options stop there.
 */
export function Pagination({ page = 1, limit = 20, total = 0, onPageChange, className }) {
  const pageCount = Math.max(1, Math.ceil(total / (limit || 20)));
  const first = total === 0 ? 0 : (page - 1) * limit + 1;
  const last = Math.min(page * limit, total);

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-2', className)}>
      <p className="text-xs text-muted-foreground">
        {total === 0 ? (
          'No results'
        ) : (
          <>
            Showing <span className="tabular font-medium text-foreground">{first}</span>–
            <span className="tabular font-medium text-foreground">{last}</span> of{' '}
            <span className="tabular font-medium text-foreground">{total}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          Page <span className="tabular">{page}</span> of <span className="tabular">{pageCount}</span>
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          aria-label="Next page"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}