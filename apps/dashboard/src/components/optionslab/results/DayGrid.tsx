/**
 * Day by day: one row per trading day with the day's context (weekday, DTE, VIX at open,
 * opening gap, the index's intraday shape) and each strategy's ₹ per lot. Clicking a cell
 * opens that strategy-day's replay in a full-width row directly under the day.
 */

import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';

import { seriesCssColor } from '../../../lib/chartTheme';
import { cn } from '../../../lib/cn';
import { EMPTY, formatDay, formatNumber, formatPct, formatPnl } from '../../../lib/format';
import { dteText } from '../../../lib/legwiseResults';
import type { DayAnatomy, SavedResult } from '../../../types/legwise';
import { Badge } from '../../ui/Badge';
import { InfoTooltip } from '../../ui/InfoTooltip';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { DayForensics } from '../DayForensics';
import { SegmentChips } from '../anatomy';
import { TradeLog, pnlClass } from '../shared';

/** The context columns before the per-strategy ones (Day … shape). */
const CONTEXT_COLUMNS = 6;

/** Cell shading by |₹ per lot| relative to the biggest cell: 3 literal buckets so
 * Tailwind's JIT sees every class name. */
function shade(value: number, max: number): string {
  if (max <= 0 || value === 0) return '';
  const r = Math.abs(value) / max;
  const tone = value > 0 ? 'positive' : 'negative';
  const step = r > 0.66 ? 3 : r > 0.33 ? 2 : 1;
  return {
    positive: ['bg-positive/10', 'bg-positive/20', 'bg-positive/30'],
    negative: ['bg-negative/10', 'bg-negative/20', 'bg-negative/30'],
  }[tone][step - 1] as string;
}

export interface GridStrategy {
  id: string;
  lots: number;
  colorIndex: number;
}

export interface DaySelection {
  strategy: string;
  day: string;
}

function HelpTh({ label, help, align }: { label: string; help: string; align?: 'right' }) {
  return (
    <Th {...(align ? { align } : {})}>
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'justify-end')}>
        {label}
        <InfoTooltip text={help} label={`About ${label}`} />
      </span>
    </Th>
  );
}

/**
 * The expanded row's content. The cell spans the whole table, which can be wider than the
 * screen, so the content is pinned to the left edge of the scrolling box and sized to that
 * box: the replay stays readable while the grid scrolls sideways. Scrolls itself into view
 * when it opens.
 */
function ExpandedPane({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    const scroller = el?.closest('table')?.parentElement;
    if (!el || !scroller) return;
    const measure = () => setWidth(scroller.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    el.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="sticky left-0 scroll-mt-14 px-4 py-4 focus-visible:outline-none"
      style={width === null ? undefined : { width }}
    >
      {children}
    </div>
  );
}

export function DayGrid({
  days,
  strategies,
  rows,
  anatomyByDay,
  underlying,
  selected,
  onSelect,
}: {
  /** Newest first. */
  days: string[];
  strategies: GridStrategy[];
  /** Every saved result in view, stale ones included (they render struck through). */
  rows: SavedResult[];
  anatomyByDay: Map<string, DayAnatomy>;
  underlying: string;
  selected: DaySelection | null;
  onSelect: (next: DaySelection | null) => void;
}) {
  const byCell = new Map(rows.map((r) => [`${r.strategy_id}|${r.day}`, r]));
  const lotsById = new Map(strategies.map((s) => [s.id, s.lots]));
  const maxCell = Math.max(
    0,
    ...rows
      .filter((r) => r.current && lotsById.has(r.strategy_id))
      .map((r) => Math.abs(r.net / (lotsById.get(r.strategy_id) ?? 1))),
  );
  const picked = selected ? byCell.get(`${selected.strategy}|${selected.day}`) : undefined;

  return (
    <Table stickyFirstCol maxHeight="80vh">
      <THead>
        <Th>Day</Th>
        <Th>Weekday</Th>
        <HelpTh
          label="DTE"
          help={`Trading days to ${underlying}'s nearest weekly expiry at the open. "Expiry" marks expiry day itself, when premiums decay fastest. Blank before the expiry calendar is reliable.`}
        />
        <HelpTh
          label="VIX open"
          align="right"
          help="India VIX at the open: the market's implied volatility going into the day."
        />
        <HelpTh
          label="Gap"
          align="right"
          help={`${underlying}'s open against the previous close. A large gap means much of the day's move happened before any strategy could enter.`}
        />
        <HelpTh
          label={`${underlying} shape`}
          help={`${underlying}'s day type in each intraday segment (open, mid, close). The legend above explains the glyphs; hover a chip for the numbers.`}
        />
        {strategies.map((s) => (
          <Th key={s.id} align="right" title={s.id}>
            <span className="inline-flex max-w-[11rem] items-center justify-end gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: seriesCssColor(s.colorIndex) }}
              />
              <span className="truncate normal-case tracking-normal">{s.id}</span>
            </span>
          </Th>
        ))}
      </THead>
      <tbody>
        {days.map((day) => {
          const a = anatomyByDay.get(day);
          const dte = dteText(a);
          const open = picked !== undefined && picked.day === day;
          return (
            <Fragment key={day}>
              <TRow selected={open}>
                <Td numeric className="whitespace-nowrap">
                  {formatDay(day)}
                </Td>
                <Td className="text-muted">{a?.weekday ?? EMPTY}</Td>
                <Td numeric>
                  {dte === null ? (
                    <span className="text-faint">{EMPTY}</span>
                  ) : a?.is_expiry ? (
                    <Badge status="attention">{dte}</Badge>
                  ) : (
                    dte
                  )}
                </Td>
                <Td align="right" numeric>
                  {formatNumber(a?.vix_open, 2)}
                </Td>
                <Td align="right" numeric>
                  {formatPct(a?.gap_pct, 2, { unit: 'percent', sign: true })}
                </Td>
                <Td>
                  <SegmentChips anatomy={a} />
                </Td>
                {strategies.map((s) => {
                  const r = byCell.get(`${s.id}|${day}`);
                  if (!r) {
                    return (
                      <Td key={s.id} align="right" numeric className="text-faint">
                        {EMPTY}
                      </Td>
                    );
                  }
                  const perLot = r.net / s.lots;
                  const active = open && picked?.strategy_id === s.id;
                  return (
                    <Td key={s.id} align="right" numeric>
                      <button
                        type="button"
                        aria-expanded={active}
                        aria-label={`${s.id}, ${formatDay(day)}: ${formatPnl(perLot)} per lot. ${active ? 'Close' : 'Open'} the replay`}
                        onClick={() => onSelect(active ? null : { strategy: s.id, day })}
                        title={
                          r.current
                            ? (r.stopped_by ?? 'Replay this day')
                            : 'Ran an older version of this strategy; not counted in the totals'
                        }
                        className={cn(
                          'rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          active && 'ring-2 ring-border-strong',
                          r.current ? pnlClass(r.net) : 'text-faint line-through',
                          r.current && shade(perLot, maxCell),
                        )}
                      >
                        {formatPnl(perLot)}
                      </button>
                    </Td>
                  );
                })}
              </TRow>
              {open && picked ? (
                <tr className="border-b border-border bg-surface-2/30">
                  <td colSpan={CONTEXT_COLUMNS + strategies.length} className="p-0">
                    <ExpandedPane
                      key={`${picked.strategy_id}:${picked.day}:${picked.strategy_sha}`}
                    >
                      <DayForensics
                        embedded
                        strategy={picked.strategy_id}
                        day={picked.day}
                        sha={picked.strategy_sha}
                        stale={!picked.current}
                        onClose={() => onSelect(null)}
                        fallback={<TradeLog trades={picked.trades} />}
                      />
                    </ExpandedPane>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </Table>
  );
}
