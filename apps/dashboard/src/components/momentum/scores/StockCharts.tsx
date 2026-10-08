import { cn } from '../../../lib/cn';
import { EMPTY, formatDay, formatInr } from '../../../lib/format';
import { type BuyZone, DECILE_CLASS, decileOf } from '../../../lib/momentumScores';

const WIDTH = 448;

function path(points: Array<[number, number] | null>): string {
  let d = '';
  let pen = false;
  for (const point of points) {
    if (!point) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** A year of weekly closes with the 40-week average dashed beneath or above them. */
export function PriceChart({
  weeks,
  closes,
  ma40,
}: {
  weeks: readonly string[];
  closes: ReadonlyArray<number | null>;
  ma40: ReadonlyArray<number | null>;
}) {
  const height = 150;
  const pad = { l: 6, r: 6, t: 10, b: 20 };
  const values = [...closes, ...ma40].filter((v): v is number => v != null);
  if (closes.length < 2 || values.length === 0)
    return <p className="text-sm text-muted">No price history.</p>;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number): number => pad.l + (i / (closes.length - 1)) * (WIDTH - pad.l - pad.r);
  const y = (v: number): number => pad.t + (1 - (v - lo) / span) * (height - pad.t - pad.b);
  const line = (series: ReadonlyArray<number | null>) =>
    path(series.map((v, i) => (v == null ? null : [x(i), y(v)])));
  return (
    <svg
      role="img"
      aria-label={`Weekly closes over the last year, from ${formatInr(closes[0], { dp: 0 })} to ${formatInr(closes.at(-1), { dp: 0 })}, with the 40-week average`}
      viewBox={`0 0 ${WIDTH} ${height}`}
      className="block h-auto w-full"
    >
      <path
        d={line(ma40)}
        fill="none"
        className="stroke-faint"
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />
      <path
        d={line(closes)}
        fill="none"
        className="stroke-primary"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <text x={pad.l} y={height - 5} className="fill-faint font-mono text-[10px]">
        {formatDay(weeks[0])}
      </text>
      <text
        x={WIDTH - pad.r}
        y={height - 5}
        textAnchor="end"
        className="fill-faint font-mono text-[10px]"
      >
        {formatDay(weeks.at(-1))}
      </text>
      <text
        x={WIDTH - pad.r}
        y={pad.t - 1}
        textAnchor="end"
        className="fill-muted font-mono text-[10px]"
      >
        {formatInr(hi, { dp: 0 })}
      </text>
      <text
        x={WIDTH - pad.r}
        y={height - pad.b - 3}
        textAnchor="end"
        className="fill-muted font-mono text-[10px]"
      >
        {formatInr(lo, { dp: 0 })}
      </text>
    </svg>
  );
}

/** The decile at every lookback over recent weeks, one row per lookback, oldest week on the left. */
export function ScoreHistoryGrid({
  weeks,
  scores,
  lookbacks,
}: {
  weeks: readonly string[];
  scores: Record<string, ReadonlyArray<number | null>>;
  lookbacks: readonly number[];
}) {
  return (
    <div
      role="img"
      aria-label={`Score deciles of each lookback over the last ${weeks.length} weeks`}
      className="grid grid-cols-[2.5rem_1fr] items-center gap-x-2 gap-y-0.5"
    >
      {lookbacks.map((weeksBack) => (
        <div key={weeksBack} className="contents">
          <span className="metric text-right text-[11px] text-faint">{weeksBack}w</span>
          <span className="flex gap-0.5">
            {weeks.map((week, i) => {
              const score = scores[String(weeksBack)]?.[i] ?? null;
              const decile = decileOf(score);
              return (
                <span
                  key={week}
                  title={`${formatDay(week)}: ${decile === null ? 'no score' : `decile ${decile}`}`}
                  className={cn(
                    'h-4 flex-1 rounded-sm',
                    decile === null ? 'bg-surface-2' : DECILE_CLASS[decile],
                  )}
                />
              );
            })}
          </span>
        </div>
      ))}
      <span />
      <span className="metric flex justify-between text-[10px] text-faint">
        <span>{formatDay(weeks[0])}</span>
        <span>{formatDay(weeks.at(-1))}</span>
      </span>
    </div>
  );
}

/** The composite rank over recent weeks, 1 at the top, on a log scale so 1 to 20 stays readable
 * when the stock has been ranked in the hundreds; the buy and exit ranks drawn across it. */
export function RankChart({
  weeks,
  ranks,
  zone,
}: {
  weeks: readonly string[];
  ranks: ReadonlyArray<number | null>;
  zone: BuyZone;
}) {
  const height = 96;
  const pad = { l: 6, r: 6, t: 8, b: 18 };
  const known = ranks.filter((r): r is number => r != null);
  if (known.length < 2) return <p className="text-sm text-muted">No rank history yet.</p>;
  const worst = Math.max(zone.exitRank * 2, ...known);
  const logTop = Math.log(1);
  const logBottom = Math.log(worst);
  const y = (rank: number): number =>
    pad.t + ((Math.log(rank) - logTop) / (logBottom - logTop)) * (height - pad.t - pad.b);
  const x = (i: number): number => pad.l + (i / (ranks.length - 1)) * (WIDTH - pad.l - pad.r);
  const sourceNote = zone.source === 'favourite' ? 'your favourite' : 'Broad defaults';
  return (
    <svg
      role="img"
      aria-label={`Composite rank over the last ${ranks.length} weeks, now ${ranks.at(-1) ?? 'none'}; exit rank ${zone.exitRank}`}
      viewBox={`0 0 ${WIDTH} ${height}`}
      className="block h-auto w-full"
    >
      <line
        x1={pad.l}
        x2={WIDTH - pad.r}
        y1={y(zone.topN)}
        y2={y(zone.topN)}
        className="stroke-primary/50"
        strokeWidth={1}
      />
      <line
        x1={pad.l}
        x2={WIDTH - pad.r}
        y1={y(zone.exitRank)}
        y2={y(zone.exitRank)}
        className="stroke-warning"
        strokeWidth={1}
        strokeDasharray="4 3"
      />
      <text
        x={WIDTH - pad.r}
        y={y(zone.topN) - 3}
        textAnchor="end"
        className="fill-primary text-[10px]"
      >
        buy: top {zone.topN}
      </text>
      <text
        x={WIDTH - pad.r}
        y={y(zone.exitRank) + 11}
        textAnchor="end"
        className="fill-warning text-[10px]"
      >
        exit past {zone.exitRank} ({sourceNote})
      </text>
      <path
        d={path(ranks.map((r, i) => (r == null ? null : [x(i), y(r)])))}
        fill="none"
        className="stroke-foreground"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <text x={pad.l} y={height - 4} className="fill-faint font-mono text-[10px]">
        {formatDay(weeks[0])}
      </text>
      <text
        x={WIDTH - pad.r}
        y={height - 4}
        textAnchor="end"
        className="fill-faint font-mono text-[10px]"
      >
        {formatDay(weeks.at(-1))}
      </text>
    </svg>
  );
}

export function Stat({
  label,
  value,
  tone,
}: { label: string; value: string; tone?: 'positive' | 'negative' }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border px-1 py-2 text-sm">
      <span className="text-muted">{label}</span>
      <span
        className={cn(
          'metric text-foreground',
          tone === 'positive' && 'text-positive',
          tone === 'negative' && 'text-negative',
        )}
      >
        {value || EMPTY}
      </span>
    </div>
  );
}
