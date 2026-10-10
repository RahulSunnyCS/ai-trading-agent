/**
 * The daily log's calendar: weekday columns (the exchange is shut at weekends), one cell a trading
 * day, the focus list's gross per lot-day as the shading. Holidays are hatched, days still to come
 * are dashed, a day with a stop, a late entry or no entry has a red outline. A cell with no
 * figure says why in words; nothing is drawn as a flat zero.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';

import { cn } from '../../lib/cn';
import { formatDay, formatInr } from '../../lib/format';
import {
  type CalendarCell,
  HATCH_STYLE,
  type Month,
  WEEKDAYS,
  focusStopped,
  isFlagged,
  monthGrid,
  monthTitle,
  shadeClass,
  shadeScale,
  shiftMonth,
} from '../../lib/rotationDailyLogView';
import type { RotationListKey, RotationRow } from '../../types/rotationDailyLog';
import { Button } from '../ui/Button';
import { pnlClass } from './shared';

const KIND_NOTE: Partial<Record<CalendarCell['kind'], string>> = {
  waiting: 'waiting',
  late: 'late',
  not_recorded: 'not recorded',
};

function cellTitle(cell: CalendarCell, focus: RotationListKey): string {
  const when = formatDay(cell.day);
  if (cell.kind === 'holiday')
    return `${when}: exchange holiday${cell.holiday ? `, ${cell.holiday}` : ''}`;
  if (cell.kind === 'future') return `${when}: not yet`;
  if (cell.kind === 'none') return `${when}: no entry in this view`;
  const row = cell.row;
  if (row === null) return when;
  const head = `${when}: ${row.status_detail || row.status.replace('_', ' ')}`;
  if (cell.value === null) return head;
  return `${when}: list ${focus} ${formatInr(cell.value, { sign: true })} gross per lot-day`;
}

function Cell({
  cell,
  focus,
  scale,
  selected,
  onOpen,
}: {
  cell: CalendarCell;
  focus: RotationListKey;
  scale: number;
  selected: boolean;
  onOpen: (day: string) => void;
}) {
  if (cell.kind === 'outside') return <div aria-hidden="true" className="min-h-[3.5rem]" />;
  const row = cell.row;
  const openable = row !== null;
  const shade = cell.kind === 'scored' || cell.kind === 'late' ? shadeClass(cell.value, scale) : '';
  const body = (
    <>
      <span className="text-xs text-faint">{cell.date}</span>
      {cell.value !== null ? (
        <span className={cn('metric text-sm', pnlClass(cell.value))}>
          {formatInr(cell.value, { sign: true })}
        </span>
      ) : KIND_NOTE[cell.kind] ? (
        <span
          className={cn('text-xs', cell.kind === 'not_recorded' ? 'text-negative' : 'text-muted')}
        >
          {KIND_NOTE[cell.kind]}
        </span>
      ) : null}
      {focusStopped(row, focus) ? (
        <span className="text-[10px] uppercase tracking-wide text-negative">stop</span>
      ) : null}
      {row?.source === 'reconstructed' ? (
        <span className="text-[10px] uppercase tracking-wide text-faint">recon.</span>
      ) : null}
    </>
  );
  const className = cn(
    'flex min-h-[3.5rem] flex-col items-start justify-between rounded-md border p-1.5 text-left',
    cell.kind === 'future' && 'border-dashed border-border',
    cell.kind === 'none' && 'border-border/60',
    cell.kind === 'holiday' && 'border-border',
    openable && 'border-border',
    isFlagged(row) && 'border-negative ring-1 ring-negative',
    selected && 'ring-2 ring-primary',
    shade,
  );
  const style = cell.kind === 'holiday' ? HATCH_STYLE : undefined;
  if (!openable) {
    return (
      <div className={className} style={style} title={cellTitle(cell, focus)}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(cell.day)}
      title={cellTitle(cell, focus)}
      aria-label={`${formatDay(cell.day)}: open the day`}
      aria-pressed={selected}
      className={cn(
        className,
        'transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {body}
    </button>
  );
}

export function RotationDailyLogCalendar({
  month,
  onMonth,
  rows,
  holidays,
  focus,
  today,
  selectedDay,
  onOpen,
  firstMonth,
  lastMonth,
}: {
  month: Month;
  onMonth: (m: Month) => void;
  rows: readonly RotationRow[];
  holidays: readonly { day: string; name: string }[];
  focus: RotationListKey;
  today: string;
  selectedDay: string | null;
  onOpen: (day: string) => void;
  /** The earliest and latest months worth stepping to (null: unbounded). */
  firstMonth: Month | null;
  lastMonth: Month | null;
}) {
  const weeks = useMemo(
    () => monthGrid(month, rows, holidays, focus, today),
    [month, rows, holidays, focus, today],
  );
  const scale = useMemo(() => shadeScale(rows, focus), [rows, focus]);
  const index = (m: Month) => m.year * 12 + m.month;
  const canBack = firstMonth === null || index(month) > index(firstMonth);
  const canForward = lastMonth === null || index(month) < index(lastMonth);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{monthTitle(month)}</h3>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous month"
            disabled={!canBack}
            onClick={() => onMonth(shiftMonth(month, -1))}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next month"
            disabled={!canForward}
            onClick={() => onMonth(shiftMonth(month, 1))}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {WEEKDAYS.map((w) => (
          <div key={w} className="px-1 text-xs font-semibold uppercase tracking-wider text-faint">
            {w}
          </div>
        ))}
        {weeks.flatMap((week) =>
          week.map((cell) => (
            <Cell
              key={cell.day}
              cell={cell}
              focus={focus}
              scale={scale}
              selected={cell.day === selectedDay}
              onOpen={onOpen}
            />
          )),
        )}
      </div>
      <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm bg-positive/20" aria-hidden="true" />
          list {focus} gained
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm bg-negative/20" aria-hidden="true" />
          list {focus} lost (shading scales to the largest day in view)
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-sm border border-negative ring-1 ring-negative"
            aria-hidden="true"
          />
          late, not recorded or a fallback input
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-sm border border-border"
            style={HATCH_STYLE}
            aria-hidden="true"
          />
          exchange holiday
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-sm border border-dashed border-border"
            aria-hidden="true"
          />
          not yet
        </li>
      </ul>
    </div>
  );
}
