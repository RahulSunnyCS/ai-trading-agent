/**
 * Calendar heatmap: columns = weeks (month labels on top), rows = Mon..Fri (labels on the
 * left). Runs of one colour are the "periods" the regimes study is about.
 *
 * Not hover-only and not colour-only: trend cells carry ↑ / ↓, every cell is a button with a
 * spoken label, the grid is one tab stop with arrow-key movement, and the focused, hovered
 * or tapped day is spelled out in the readout under the grid.
 */

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../../../lib/cn';
import { formatDay, formatMultiple, formatPct } from '../../../lib/format';
import { regimeMeta } from '../../../lib/regimeMeta';
import { calendarWeeks, weekStart, weekdayIndex } from '../../../lib/regimeStats';
import type { AnatomySegment, DayAnatomy, SegmentLabel } from '../../../types/legwise';

/** Cell fill per label. Green / red are direction; the glyph repeats it without colour. */
export const HEAT_CELL: Record<SegmentLabel, string> = {
  TREND_UP: 'bg-positive/70',
  TREND_DOWN: 'bg-negative/70',
  CHOP: 'bg-warning/60',
  QUIET: 'bg-border-strong/50',
  UNKNOWN: 'bg-border/40',
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;
const CELL_PX = 14;
const GAP_PX = 2;

function segmentOf(day: DayAnatomy, series: number): AnatomySegment | null {
  return (series < 0 ? day.whole : day.segments[series]) ?? null;
}

/** "Wed 23 Sep 2026: quiet, range 0.5× implied, move +0.41%". */
export function describeDay(day: DayAnatomy, series: number): string {
  const seg = segmentOf(day, series);
  const head = `${day.weekday} ${formatDay(day.day)}`;
  if (!seg) return `${head}: no data for this part of the day`;
  const range =
    seg.range_over_implied === null
      ? 'no VIX reading to compare the range with'
      : `range ${formatMultiple(seg.range_over_implied, 1)} implied`;
  const move = `move ${formatPct(seg.ret_pct, 2, { sign: true, unit: 'percent' })}`;
  const expiry = day.is_expiry ? ', expiry day' : '';
  return `${head}: ${regimeMeta(seg.label).label.toLowerCase()}, ${range}, ${move}${expiry}`;
}

export function CalendarHeatmap({
  days,
  series,
  caption,
  isDimmed,
}: {
  days: DayAnatomy[];
  /** -1 = whole day, otherwise the segment index. */
  series: number;
  caption: string;
  /** Days outside the current filter: drawn faint, still readable. */
  isDimmed?: ((day: DayAnatomy) => boolean) | undefined;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const cells = useRef(new Map<string, HTMLButtonElement>());
  const [active, setActive] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const layout = useMemo(() => {
    const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
    const weeks = calendarWeeks(sorted.map((d) => d.day));
    const byDay = new Map(sorted.map((d) => [d.day, d]));
    const byCell = new Map(sorted.map((d) => [`${weekStart(d.day)}:${weekdayIndex(d.day)}`, d]));
    return { sorted, weeks, byDay, byCell };
  }, [days]);
  const { sorted, weeks, byDay, byCell } = layout;

  // The roving tab stop: the active day, else the latest one.
  const tabStop =
    active !== null && byDay.has(active) ? active : (sorted[sorted.length - 1]?.day ?? null);
  const shown = hovered ?? active;
  const shownDay = shown === null ? undefined : byDay.get(shown);

  // Most recent weeks are the interesting ones: start scrolled to the right edge.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only needs to run when the span changes
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [weeks.length]);

  function focusDay(day: string | undefined): void {
    if (day === undefined) return;
    setActive(day);
    cells.current.get(day)?.focus();
  }

  /** The same weekday `step` weeks away, skipping weeks where that weekday has no data. */
  function sameWeekday(day: string, step: 1 | -1): string | undefined {
    const column = weeks.findIndex((w) => w.week === weekStart(day));
    const row = weekdayIndex(day);
    for (let i = column + step; i >= 0 && i < weeks.length; i += step) {
      const hit = byCell.get(`${weeks[i]?.week}:${row}`);
      if (hit) return hit.day;
    }
    return undefined;
  }

  function onKeyDown(event: KeyboardEvent, day: string): void {
    const index = sorted.findIndex((d) => d.day === day);
    let target: string | undefined;
    if (event.key === 'ArrowDown') target = sorted[index + 1]?.day;
    else if (event.key === 'ArrowUp') target = sorted[index - 1]?.day;
    else if (event.key === 'ArrowRight') target = sameWeekday(day, 1);
    else if (event.key === 'ArrowLeft') target = sameWeekday(day, -1);
    else if (event.key === 'Home') target = sorted[0]?.day;
    else if (event.key === 'End') target = sorted[sorted.length - 1]?.day;
    else return;
    event.preventDefault();
    focusDay(target);
  }

  // "Sep" on the column where a month starts, "Jan 2027" where a year does. A label needs
  // about three columns, so when the next column starts a month too (history that begins in
  // a month's last week) the earlier label gives way and the later one carries the year.
  const monthLabels = weeks.map((w, i) => {
    if (w.monthStart === null || weeks[i + 1]?.monthStart) return null;
    const withYear = w.yearStart || (weeks[i - 1]?.yearStart ?? false);
    return formatDay(w.monthStart).slice(3, withYear ? undefined : 6);
  });
  const track = `repeat(${weeks.length}, ${CELL_PX}px)`;

  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted">{caption}</p>
      <div className="flex gap-1.5">
        <div
          aria-hidden="true"
          className="grid shrink-0 pt-4 text-[10px] leading-none text-faint"
          style={{ gridTemplateRows: `repeat(5, ${CELL_PX}px)`, rowGap: GAP_PX }}
        >
          {WEEKDAYS.map((name) => (
            <span key={name} className="flex items-center">
              {name}
            </span>
          ))}
        </div>
        <div ref={scroller} className="min-w-0 overflow-x-auto p-0.5 pb-1">
          <div
            aria-hidden="true"
            className="grid h-4 text-[10px] leading-none text-faint"
            style={{ gridTemplateColumns: track, columnGap: GAP_PX }}
          >
            {weeks.map((w, i) => (
              <span key={w.week} className="whitespace-nowrap">
                {monthLabels[i]}
              </span>
            ))}
          </div>
          <div
            // biome-ignore lint/a11y/useSemanticElements: a CSS grid of day cells, not a form; a fieldset would not lay out as a grid in every browser
            role="group"
            aria-label={`${caption}: one cell per trading day. Arrow keys move between days.`}
            className="grid"
            style={{
              gridTemplateRows: `repeat(5, ${CELL_PX}px)`,
              gridTemplateColumns: track,
              gap: GAP_PX,
            }}
          >
            {weeks.flatMap((w, column) =>
              WEEKDAYS.map((name, row) => {
                const d = byCell.get(`${w.week}:${row}`);
                const place = { gridColumn: column + 1, gridRow: row + 1 };
                if (!d) return <span key={`${w.week}:${name}`} style={place} />;
                const seg = segmentOf(d, series);
                const dimmed = isDimmed?.(d) ?? false;
                const text = describeDay(d, series);
                const trend = seg?.label === 'TREND_UP' || seg?.label === 'TREND_DOWN';
                return (
                  <button
                    key={d.day}
                    type="button"
                    ref={(el) => {
                      if (el) cells.current.set(d.day, el);
                      else cells.current.delete(d.day);
                    }}
                    tabIndex={d.day === tabStop ? 0 : -1}
                    aria-label={dimmed ? `${text} (outside the current filter)` : text}
                    aria-pressed={d.day === active}
                    style={place}
                    onClick={() => setActive(d.day)}
                    onFocus={() => setActive(d.day)}
                    onMouseEnter={() => setHovered(d.day)}
                    onMouseLeave={() => setHovered(null)}
                    onKeyDown={(event) => onKeyDown(event, d.day)}
                    className={cn(
                      'flex items-center justify-center rounded-sm text-[10px] font-bold leading-none text-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      seg ? HEAT_CELL[seg.label] : 'border border-dashed border-border',
                      dimmed && 'opacity-25',
                      d.day === shown && 'ring-1 ring-foreground',
                    )}
                  >
                    {trend ? <span aria-hidden="true">{regimeMeta(seg.label).glyph}</span> : null}
                  </button>
                );
              }),
            )}
          </div>
        </div>
      </div>
      <p className="mt-1 min-h-4 text-xs text-muted">
        {shownDay ? (
          <>
            <span aria-hidden="true">{regimeMeta(segmentOf(shownDay, series)?.label).glyph}</span>{' '}
            {describeDay(shownDay, series)}
          </>
        ) : (
          <span className="text-faint">
            {sorted.length} days. Hover, tap or focus a cell to read that day.
          </span>
        )}
      </p>
    </div>
  );
}

/** What the cell colours and glyphs mean. */
export function HeatmapLegend({ states }: { states: readonly SegmentLabel[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {states.map((s) => {
        const meta = regimeMeta(s);
        return (
          <span key={s} className="inline-flex items-center gap-1.5" title={meta.definition}>
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-[10px] font-bold leading-none text-foreground',
                HEAT_CELL[s],
              )}
            >
              {s === 'TREND_UP' || s === 'TREND_DOWN' ? meta.glyph : null}
            </span>
            {meta.label}
          </span>
        );
      })}
    </div>
  );
}
