import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import { cn } from '../../lib/cn';
import { InfoTooltip } from '../ui/InfoTooltip';
import { Th } from '../ui/Table';

/** A sortable header cell: a button inside a <th> that carries `aria-sort`. */
export function SortTh<K extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = 'left',
  help,
}: {
  label: string;
  sortKey: K;
  activeKey: K;
  dir: 'asc' | 'desc';
  onSort: (key: K) => void;
  align?: 'left' | 'right';
  help?: string;
}) {
  const active = activeKey === sortKey;
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <Th align={align} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'justify-end')}>
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className={cn(
            'inline-flex items-center gap-1 rounded uppercase tracking-wider transition-colors hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            active && 'text-foreground',
          )}
        >
          {label}
          <Icon className={cn('h-3 w-3', !active && 'opacity-50')} aria-hidden="true" />
        </button>
        {help ? <InfoTooltip text={help} label={`About ${label}`} /> : null}
      </span>
    </Th>
  );
}
