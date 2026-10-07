import { cn } from '../../../lib/cn';
import { EMPTY, formatNumber, formatPct } from '../../../lib/format';
import { sparklinePath } from '../../../lib/momentumCompare';
import { DECILE_CLASS, TREND_LABEL, type TrendTag, decileOf } from '../../../lib/momentumScores';
import { Badge } from '../../ui/Badge';

/**
 * A row of small coloured cells, one per lookback, each the 1–10 decile of the return over that
 * many weeks against all scored stocks (10 = the strongest tenth). The colours are the shape: all
 * green is a leader, green on the left only a new trend, green on the right only a fading one.
 * `returns` adds the raw return to each cell's hover text.
 */
export function ScoreStrip({
  scores,
  lookbacks,
  returns,
}: {
  scores: Record<string, number | null | undefined>;
  lookbacks: readonly number[];
  returns?: Record<string, number | null | undefined>;
}) {
  const parts = lookbacks.map((weeks) => {
    const score = scores[String(weeks)];
    const decile = decileOf(score);
    const ret = returns?.[String(weeks)];
    const detail =
      decile === null
        ? 'no score'
        : `score ${formatNumber(score, 0)}${ret == null ? '' : `, return ${formatPct(ret, 1, { sign: true })}`}`;
    return {
      weeks,
      decile,
      text: `${weeks} weeks: ${decile === null ? 'none' : decile} (${detail})`,
    };
  });
  return (
    <span
      role="img"
      aria-label={`Deciles by lookback: ${parts.map((part) => `${part.weeks} weeks ${part.decile ?? 'none'}`).join(', ')}`}
      className="inline-flex gap-0.5"
    >
      {parts.map((part) => (
        <span
          key={part.weeks}
          title={part.text}
          className={cn(
            'metric inline-flex h-5 w-6 items-center justify-center rounded text-[11px] font-semibold',
            part.decile === null
              ? 'bg-surface-2 text-faint'
              : `${DECILE_CLASS[part.decile]} text-foreground`,
          )}
        >
          {part.decile ?? EMPTY}
        </span>
      ))}
    </span>
  );
}

const TREND_TONE = {
  leader: 'positive',
  emerging: 'info',
  fading: 'warning',
  laggard: 'negative',
  mixed: 'neutral',
} as const satisfies Record<TrendTag, 'positive' | 'info' | 'warning' | 'negative' | 'neutral'>;

export function TrendBadge({ trend }: { trend: TrendTag | null }) {
  if (!trend) return <span className="text-faint">{EMPTY}</span>;
  return (
    <Badge tone={TREND_TONE[trend]} dot>
      {TREND_LABEL[trend]}
    </Badge>
  );
}

const SPARK_WIDTH = 72;
const SPARK_HEIGHT = 20;

/** The last 26 weekly closes as a small line, green when it ended above where it started. */
export function Spark({ values, label }: { values: readonly number[] | undefined; label: string }) {
  const path =
    values && values.length > 1 ? sparklinePath([...values], SPARK_WIDTH, SPARK_HEIGHT) : null;
  if (!path || !values) return <span className="text-faint">{EMPTY}</span>;
  const up = (values.at(-1) ?? 0) >= (values[0] ?? 0);
  return (
    <svg
      role="img"
      aria-label={label}
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      className={cn('block', up ? 'text-positive' : 'text-negative')}
    >
      <title>{label}</title>
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
