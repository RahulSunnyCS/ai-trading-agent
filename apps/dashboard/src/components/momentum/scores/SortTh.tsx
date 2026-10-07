import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { type ScoreSort, type ScoreSortKey, ariaSort } from '../../../lib/momentumScores';
import { Th } from '../../ui/Table';

/** A sortable column header: an arrow for the active column, a neutral glyph otherwise. */
export function SortTh({
  children,
  sort,
  sortKey,
  lookback = null,
  onSort,
  align = 'left',
  title,
}: {
  children: ReactNode;
  sort: ScoreSort;
  sortKey: ScoreSortKey;
  lookback?: number | null;
  onSort: (key: ScoreSortKey, lookback: number | null) => void;
  align?: 'left' | 'right';
  title?: string;
}) {
  const state = ariaSort(sort, sortKey, lookback);
  const Icon =
    state === 'ascending' ? ArrowUp : state === 'descending' ? ArrowDown : ChevronsUpDown;
  return (
    <Th dense align={align} aria-sort={state}>
      <button
        type="button"
        title={title}
        onClick={() => onSort(sortKey, lookback)}
        className={cn(
          'inline-flex items-center gap-1 rounded uppercase tracking-wider transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          state !== 'none' && 'text-foreground',
        )}
      >
        {children}
        <Icon
          aria-hidden
          className={cn('h-3.5 w-3.5 shrink-0', state === 'none' && 'opacity-50')}
        />
      </button>
    </Th>
  );
}
