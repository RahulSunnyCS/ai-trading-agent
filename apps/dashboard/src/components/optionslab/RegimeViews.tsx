/**
 * Presentational pieces of the Market regimes tab: calendar heatmap, label-mix table,
 * transition matrix and cross-tab. All numbers come from lib/regimeStats.ts.
 */

import { useEffect, useRef } from 'react';

import { type CrossTab, MIN_CELL_COUNT, MIN_ROW_N, type Transitions } from '../../lib/regimeStats';
import type { DayAnatomy, SegmentLabel } from '../../types/legwise';
import { Badge } from '../ui/Badge';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { LABEL_TEXT, LABEL_TONE, describeSegment } from './anatomy';

export const STATES: SegmentLabel[] = ['TREND_UP', 'TREND_DOWN', 'CHOP', 'QUIET'];

const CELL: Record<SegmentLabel, string> = {
  TREND_UP: 'bg-positive/70',
  TREND_DOWN: 'bg-negative/70',
  CHOP: 'bg-warning/60',
  QUIET: 'bg-border-strong/50',
  UNKNOWN: 'bg-border/40',
};

const pct = (v: number | undefined) => (v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);

export function LabelChip({ label }: { label: string }) {
  const key = label as SegmentLabel;
  return <Badge tone={LABEL_TONE[key] ?? 'neutral'}>{LABEL_TEXT[key] ?? label}</Badge>;
}

// ---------------------------------------------------------------------------
// Calendar heatmap: columns = weeks, rows = Mon..Fri. Runs of one colour ARE the
// "periods" the study is about.
// ---------------------------------------------------------------------------

function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return d.toISOString().slice(0, 10);
}

export function CalendarHeatmap({
  days,
  series,
  caption,
}: {
  days: DayAnatomy[];
  /** -1 = whole day, otherwise the segment index. */
  series: number;
  caption: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const weeks = [...new Set(days.map((d) => weekStart(d.day)))].sort();
  const byKey = new Map(days.map((d) => [d.day, d]));
  const weekdayOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  const grid = new Map<string, DayAnatomy>();
  for (const d of days) grid.set(`${weekStart(d.day)}:${weekdayOf(d.day)}`, d);

  // Most recent weeks are the interesting ones: start scrolled to the right edge.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only needs to run when the span changes
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [weeks.length]);

  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted">{caption}</p>
      <div ref={scroller} className="overflow-x-auto pb-1">
        <div
          className="grid gap-[2px]"
          style={{
            gridTemplateRows: 'repeat(5, 11px)',
            gridAutoFlow: 'column',
            gridAutoColumns: '11px',
          }}
        >
          {weeks.flatMap((w) =>
            [0, 1, 2, 3, 4].map((wd) => {
              const d = grid.get(`${w}:${wd}`);
              const seg = d ? (series < 0 ? d.whole : d.segments[series]) : null;
              return (
                <div
                  key={`${w}:${wd}`}
                  title={d && seg ? `${d.day} ${d.weekday} — ${describeSegment(seg)}` : undefined}
                  className={`rounded-[2px] ${seg ? CELL[seg.label] : 'bg-transparent'}`}
                />
              );
            }),
          )}
        </div>
      </div>
      <span className="sr-only">{byKey.size} days</span>
    </div>
  );
}

export function HeatmapLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {STATES.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-[2px] ${CELL[s]}`} />
          {LABEL_TEXT[s]}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Label mix per segment — also how the owner calibrates the thresholds.
// ---------------------------------------------------------------------------

export function LabelMixTable({
  rows,
}: {
  rows: { name: string; rates: Record<string, number>; n: number }[];
}) {
  return (
    <Table>
      <THead>
        <Th>Segment</Th>
        <Th align="right">Days</Th>
        {STATES.map((s) => (
          <Th key={s} align="right">
            {LABEL_TEXT[s]}
          </Th>
        ))}
      </THead>
      <tbody>
        {rows.map((r) => (
          <TRow key={r.name}>
            <Td>{r.name}</Td>
            <Td align="right" numeric>
              {r.n}
            </Td>
            {STATES.map((s) => (
              <Td key={s} align="right" numeric>
                {pct(r.rates[s])}
              </Td>
            ))}
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Transition matrix: P(next day's label | today's label) beside the base rate.
// ---------------------------------------------------------------------------

export function TransitionMatrix({
  t,
  base,
}: {
  t: Transitions;
  base: Record<string, number>;
}) {
  return (
    <Table>
      <THead>
        <Th>Today ↓ → next day</Th>
        <Th align="right">n</Th>
        {t.states.map((s) => (
          <Th key={s} align="right">
            {LABEL_TEXT[s as SegmentLabel]}
          </Th>
        ))}
      </THead>
      <tbody>
        {t.states.map((from) => {
          const total = t.fromTotals[from] ?? 0;
          const thin = total < MIN_ROW_N;
          return (
            <TRow key={from} className={thin ? 'opacity-50' : ''}>
              <Td>
                <LabelChip label={from} />
              </Td>
              <Td align="right" numeric>
                {total}
              </Td>
              {t.states.map((to) => {
                const p = t.probs[from]?.[to];
                const cellN = t.counts[from]?.[to] ?? 0;
                const lift = p === undefined ? 0 : p - (base[to] ?? 0);
                const callOut = !thin && cellN >= MIN_CELL_COUNT;
                return (
                  <Td
                    key={to}
                    align="right"
                    numeric
                    title={`base rate ${pct(base[to])}; n=${t.counts[from]?.[to] ?? 0}`}
                    className={
                      callOut && lift >= 0.1
                        ? 'font-semibold text-positive'
                        : callOut && lift <= -0.1
                          ? 'text-negative'
                          : ''
                    }
                  >
                    {pct(p)}
                    <span className="ml-1 text-[10px] text-faint">
                      ({t.counts[from]?.[to] ?? 0})
                    </span>
                  </Td>
                );
              })}
            </TRow>
          );
        })}
        <TRow>
          <Td className="text-faint">Base rate</Td>
          <Td align="right">{null}</Td>
          {t.states.map((s) => (
            <Td key={s} align="right" numeric className="text-faint">
              {pct(base[s])}
            </Td>
          ))}
        </TRow>
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Within-day cross-tab: P(segment B label | segment A label), same day.
// ---------------------------------------------------------------------------

export function CrossTabTable({ t, aName, bName }: { t: CrossTab; aName: string; bName: string }) {
  return (
    <Table>
      <THead>
        <Th>
          {aName} ↓ → {bName}
        </Th>
        <Th align="right">n</Th>
        {t.cols.map((c) => (
          <Th key={c} align="right">
            {LABEL_TEXT[c as SegmentLabel]}
          </Th>
        ))}
      </THead>
      <tbody>
        {t.rows.map((r) => {
          const total = t.rowTotals[r] ?? 0;
          return (
            <TRow key={r} className={total < MIN_ROW_N ? 'opacity-50' : ''}>
              <Td>
                <LabelChip label={r} />
              </Td>
              <Td align="right" numeric>
                {total}
              </Td>
              {t.cols.map((c) => (
                <Td key={c} align="right" numeric>
                  {total ? pct((t.counts[r]?.[c] ?? 0) / total) : '—'}
                  <span className="ml-1 text-[10px] text-faint">({t.counts[r]?.[c] ?? 0})</span>
                </Td>
              ))}
            </TRow>
          );
        })}
      </tbody>
    </Table>
  );
}
