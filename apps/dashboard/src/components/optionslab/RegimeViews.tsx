/**
 * Presentational pieces of the Market regimes tab: label-mix table, transition matrix and
 * cross-tab (the calendar heatmap lives in regimes/CalendarHeatmap.tsx). All numbers come
 * from lib/regimeStats.ts; all labels, tones and glyphs from lib/regimeMeta.ts.
 *
 * Two colour scales, never mixed: green / red is trend direction (the badges and calendar
 * cells); the lift tint (primary = more often than the base rate, warning = less often) is
 * deliberately not green / red.
 */

import { cn } from '../../lib/cn';
import { EMPTY, formatInt, formatPct, formatPp } from '../../lib/format';
import { regimeMeta } from '../../lib/regimeMeta';
import {
  type CrossTab,
  LIFT_STEP,
  LIFT_STRONG,
  type LiftBand,
  MIN_CELL_COUNT,
  MIN_ROW_N,
  type Transitions,
  liftBand,
} from '../../lib/regimeStats';
import type { SegmentLabel } from '../../types/legwise';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import {
  CalendarHeatmap,
  HeatmapLegend as CalendarLegend,
  describeDay,
} from './regimes/CalendarHeatmap';
import { RegimeBadge } from './regimes/RegimeBadge';

export { CalendarHeatmap, describeDay };

export const STATES: SegmentLabel[] = ['TREND_UP', 'TREND_DOWN', 'CHOP', 'QUIET'];

/** The shared regime badge, under the name this folder has always used. */
export function LabelChip({ label }: { label: string }) {
  return <RegimeBadge regime={label} />;
}

export function HeatmapLegend() {
  return <CalendarLegend states={STATES} />;
}

/** A column header for a regime: glyph + label, with the definition on hover. */
function RegimeHeading({ regime }: { regime: string }) {
  const meta = regimeMeta(regime);
  return (
    <span title={meta.definition}>
      <span aria-hidden="true">{meta.glyph}</span> {meta.label}
    </span>
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
            <RegimeHeading regime={s} />
          </Th>
        ))}
      </THead>
      <tbody>
        {rows.map((r) => (
          <TRow key={r.name}>
            <Td>{r.name}</Td>
            <Td align="right" numeric>
              {formatInt(r.n)}
            </Td>
            {STATES.map((s) => (
              <Td key={s} align="right" numeric>
                {r.n > 0 ? formatPct(r.rates[s] ?? 0, 0) : EMPTY}
              </Td>
            ))}
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Lift: how far a conditional share sits from the base rate. Neutral diverging tint.
// ---------------------------------------------------------------------------

const LIFT_TINT: Record<LiftBand, string> = {
  2: 'bg-primary/30 font-semibold',
  1: 'bg-primary/15',
  0: '',
  [-1]: 'bg-warning/15',
  [-2]: 'bg-warning/30 font-semibold',
};

function Swatch({ band }: { band: LiftBand }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block h-3 w-4 rounded-sm border border-border', LIFT_TINT[band])}
    />
  );
}

/** Says what each of the two colour scales in the persistence table means. */
export function LiftLegend() {
  const step = formatPp(LIFT_STEP, 0);
  const strong = formatPp(LIFT_STRONG, 0);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5">
        <span className="font-medium text-foreground">Cell tint</span>
        <Swatch band={-2} />
        <Swatch band={-1} />
        less often than the base rate
        <Swatch band={1} />
        <Swatch band={2} />
        more often (from {step}, stronger from {strong})
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="font-medium text-foreground">Badges</span>
        <span className="text-positive">{regimeMeta('TREND_UP').glyph} green</span> and{' '}
        <span className="text-negative">{regimeMeta('TREND_DOWN').glyph} red</span> are trend
        direction only
      </span>
    </div>
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
        <Th align="right">Days</Th>
        {t.states.map((s) => (
          <Th key={s} align="right">
            <RegimeHeading regime={s} />
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
                {formatInt(total)}
              </Td>
              {t.states.map((to) => {
                const p = t.probs[from]?.[to];
                const cellN = t.counts[from]?.[to] ?? 0;
                const baseRate = base[to] ?? 0;
                const band = !thin && cellN >= MIN_CELL_COUNT ? liftBand(p, baseRate) : 0;
                const lift = p === undefined ? null : p - baseRate;
                return (
                  <Td
                    key={to}
                    align="right"
                    numeric
                    title={`Base rate ${formatPct(baseRate, 0)}, ${formatInt(cellN)} days`}
                    className={LIFT_TINT[band]}
                  >
                    {formatPct(p, 0)}
                    <span className="ml-1 text-[10px] text-faint">({formatInt(cellN)})</span>
                    {band !== 0 && (
                      <span className="block text-[10px] font-normal text-muted">
                        {formatPp(lift, 0)} vs base
                      </span>
                    )}
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
              {formatPct(base[s] ?? 0, 0)}
            </Td>
          ))}
        </TRow>
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Cross-tab: P(B's label | A's label) on the same day.
// ---------------------------------------------------------------------------

export function CrossTabTable({
  t,
  aName,
  bName,
  colLabel,
}: {
  t: CrossTab;
  aName: string;
  bName: string;
  /** Override the column header text. By default every key goes through lib/regimeMeta.ts. */
  colLabel?: (c: string) => string;
}) {
  return (
    <Table>
      <THead>
        <Th>
          {aName} ↓ → {bName}
        </Th>
        <Th align="right">Days</Th>
        {t.cols.map((c) => (
          <Th key={c} align="right">
            {colLabel ? colLabel(c) : <RegimeHeading regime={c} />}
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
                {formatInt(total)}
              </Td>
              {t.cols.map((c) => (
                <Td key={c} align="right" numeric>
                  {total ? formatPct((t.counts[r]?.[c] ?? 0) / total, 0) : EMPTY}
                  <span className="ml-1 text-[10px] text-faint">
                    ({formatInt(t.counts[r]?.[c] ?? 0)})
                  </span>
                </Td>
              ))}
            </TRow>
          );
        })}
      </tbody>
    </Table>
  );
}
