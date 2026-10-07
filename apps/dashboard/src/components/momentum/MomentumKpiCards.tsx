'use client';

import { formatInr, formatNumber, formatPct, formatPp } from '../../lib/format';
import { type MomentumRun, useMomentumRunsStore } from '../../store/momentumRuns';
import type { MomentumResult } from '../../types/momentum';
import { InfoTooltip } from '../ui/InfoTooltip';
import { StatCard } from '../ui/StatCard';

type Tone = 'default' | 'positive' | 'negative' | 'muted';
type Kpis = Record<string, unknown>;

function n(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function tone(value: unknown): Tone {
  const v = n(value);
  if (v === null) return 'default';
  return v > 0 ? 'positive' : v < 0 ? 'negative' : 'default';
}

/** How a KPI's change against the previous run is written. */
type DeltaKind = 'pp' | 'ratio' | 'inr';

interface KpiDef {
  label: string;
  help: string;
  value: (k: Kpis) => string;
  /** The benchmark's own figure for this KPI, where the payload carries one. */
  benchmark?: (k: Kpis) => string;
  /** Anything else worth a caption, after the benchmark figure. */
  note?: (k: Kpis) => string;
  tone?: (k: Kpis) => Tone;
  /** The KPI key compared against the previous run, and how the change is written. */
  delta?: { key: string; kind: DeltaKind };
}

const HEADLINE: KpiDef[] = [
  {
    label: '₹1 lakh became',
    help: 'Final value of ₹1 lakh invested at the start of the period and left running under this strategy.',
    value: (k) => formatInr(n(k.final_value), { compact: true }),
    benchmark: (k) => formatInr(n(k.benchmark_final_value), { compact: true }),
    delta: { key: 'final_value', kind: 'inr' },
  },
  {
    label: 'CAGR',
    help: 'Compound annual growth rate — the strategy’s average yearly return, smoothed over the whole period.',
    value: (k) => formatPct(n(k.cagr)),
    benchmark: (k) => formatPct(n(k.benchmark_cagr)),
    note: (k) => `cash ${formatPct(n(k.cash_cagr))}`,
    delta: { key: 'cagr', kind: 'pp' },
  },
  {
    label: 'Edge vs benchmark',
    help: 'How much faster (or slower) the strategy compounded per year than the benchmark — the CAGR gap.',
    value: (k) => formatPp(n(k.excess_cagr)),
    note: (k) => `beat it ${n(k.years_beating_benchmark) ?? '–'} of ${n(k.years) ?? '–'} yrs`,
    tone: (k) => tone(k.excess_cagr),
    delta: { key: 'excess_cagr', kind: 'pp' },
  },
  {
    label: 'Max drawdown',
    help: 'The worst peak-to-trough fall in portfolio value over the period — how much you’d have been down at the low point. Shown in red only when it is deeper than the benchmark’s.',
    value: (k) => formatPct(n(k.max_drawdown)),
    benchmark: (k) => formatPct(n(k.benchmark_max_drawdown)),
    // Drawdowns are negative: "worse than the benchmark" means further below zero.
    tone: (k) => {
      const own = n(k.max_drawdown);
      const reference = n(k.benchmark_max_drawdown);
      return own !== null && reference !== null && own < reference ? 'negative' : 'default';
    },
    delta: { key: 'max_drawdown', kind: 'pp' },
  },
  {
    label: 'Sharpe',
    help: 'Return above cash per unit of total volatility. Above 1 is generally considered good, above 2 very good.',
    value: (k) => formatNumber(n(k.sharpe)),
    note: (k) => `volatility ${formatPct(n(k.volatility))}`,
    delta: { key: 'sharpe', kind: 'ratio' },
  },
  {
    label: 'Sortino',
    help: 'Return above cash per unit of downside volatility only, so upside swings are not penalised. Above 1 is generally considered good, above 2 very good.',
    value: (k) => formatNumber(n(k.sortino)),
    note: () => 'downside moves only',
    delta: { key: 'sortino', kind: 'ratio' },
  },
];

const DETAIL: KpiDef[] = [
  {
    label: 'Churn',
    help: 'Share of the portfolio sold and replaced per year — higher means more trading and more cost.',
    value: (k) => formatPct(n(k.turnover_per_year), 0),
    note: () => 'of portfolio sold per year',
  },
  {
    label: 'Exits / year',
    help: 'How many positions were sold per year, on average.',
    value: (k) => formatNumber(n(k.exits_per_year), 1),
    note: (k) =>
      `${formatNumber(n(k.new_buys_per_year), 1)} new buys · ${formatNumber(n(k.top_ups_per_year), 1)} top-ups`,
  },
  {
    label: 'Avg holding',
    help: 'Average number of weeks a position was held before being sold.',
    value: (k) => `${formatNumber(n(k.avg_weeks_held), 0)} wks`,
    note: (k) => `${formatNumber(n(k.avg_holdings), 1)} positions held on average`,
  },
  {
    label: 'Win rate',
    help: 'Share of closed trades that made money.',
    value: (k) => formatPct(n(k.win_rate), 0),
    note: (k) =>
      `avg win ${formatPct(n(k.avg_win), 1, { sign: true })} · avg loss ${formatPct(n(k.avg_loss))}`,
  },
  {
    label: 'Best / worst exit',
    help: 'The single best and worst position returns, entry to exit.',
    value: (k) =>
      `${formatPct(n(k.best_trade), 0, { sign: true })} / ${formatPct(n(k.worst_trade), 0)}`,
    note: () => 'position return, entry to exit',
  },
  {
    label: 'Largest position',
    help: 'The biggest single holding ever reached, as a share of the portfolio.',
    value: (k) => formatPct(n(k.max_position_share), 0),
    note: () => 'peak share of the portfolio',
  },
  {
    label: 'Time in cash/debt',
    help: 'Share of weeks the portfolio held cash or debt instead of being fully invested.',
    value: (k) => formatPct(n(k.time_in_cash), 0),
    note: (k) => `ahead over 52w ${formatPct(n(k.pct_rolling_52w_ahead), 0)} of the time`,
  },
];

const TAX_PAID: KpiDef = {
  label: 'Tax paid',
  help: 'Capital-gains tax deducted across every sale, including a final sale at period end.',
  value: (k) => formatInr(n(k.tax_paid), { compact: true }),
  note: () => 'on ₹1 lakh start',
};

/**
 * The finished run in this session just before the one whose result is on screen, when it used
 * the same dataset. Null for the first run of a dataset, and for a result that is not one of
 * this session's runs.
 */
export function previousComparableRun(
  runs: readonly MomentumRun[],
  result: MomentumResult,
): MomentumRun | null {
  const index = runs.findIndex((run) => run.result === result);
  const current = runs[index];
  if (!current) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run && run.status === 'done' && run.result && run.dataset === current.dataset) return run;
  }
  return null;
}

function deltaText(kind: DeltaKind, change: number): string {
  if (kind === 'pp') return formatPp(change);
  if (kind === 'ratio') return formatNumber(change, 2, { sign: true });
  return formatInr(change, { compact: true, sign: true });
}

/** A higher value is better for every headline KPI (a drawdown nearer zero is "higher"). */
function deltaFor(
  def: KpiDef,
  k: Kpis,
  previous: MomentumRun | null,
): { text: string; tone: Tone } | null {
  if (!def.delta || !previous?.result) return null;
  const now = n(k[def.delta.key]);
  const before = n(previous.result.kpis[def.delta.key]);
  if (now === null || before === null) return null;
  const change = now - before;
  const name = previous.savedAs ?? 'previous run';
  return {
    text: `${deltaText(def.delta.kind, change)} vs ${name}`,
    tone: change > 0 ? 'positive' : change < 0 ? 'negative' : 'muted',
  };
}

function Tile({
  def,
  k,
  benchmarkName,
  previous,
}: { def: KpiDef; k: Kpis; benchmarkName: string; previous: MomentumRun | null }) {
  const delta = deltaFor(def, k, previous);
  const note = [
    def.benchmark ? `${benchmarkName} ${def.benchmark(k)}` : null,
    def.note?.(k) ?? null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  return (
    <StatCard
      label={def.label}
      hint={def.help}
      value={def.value(k)}
      note={note || undefined}
      tone={def.tone?.(k) ?? 'default'}
      delta={delta?.text}
      deltaTone={delta?.tone ?? 'muted'}
    />
  );
}

/** Headline KPI tiles, plus the full metric set when `expanded`. Header/toggle live in the caller. */
export function MomentumKpiCards({
  result,
  tax,
  expanded,
  detailOnly = false,
}: {
  result: MomentumResult;
  tax: boolean;
  expanded: boolean;
  /** Only the detail tiles: the headline strip (MomentumHeadline) shows the rest. */
  detailOnly?: boolean;
}) {
  const k = result.kpis;
  const b = result.benchmark_name;
  const runs = useMomentumRunsStore((state) => state.runs);
  const previous = previousComparableRun(runs, result);
  const detail = tax ? [...DETAIL, TAX_PAID] : DETAIL;

  if (detailOnly) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {detail.map((def) => (
          <Tile key={def.label} def={def} k={k} benchmarkName={b} previous={null} />
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        {HEADLINE.map((def) => (
          <Tile key={def.label} def={def} k={k} benchmarkName={b} previous={previous} />
        ))}
      </div>
      {result.comparisons?.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-surface-2/50 px-3 py-2 text-xs text-muted">
          <span className="flex items-center gap-1 font-medium text-foreground">
            Edge vs dividend-inclusive indices
            <InfoTooltip
              label="About dividend-inclusive indices"
              text="Total-return (TRI) indices reinvest dividends, so they are the honest passive alternative. Nifty200 Momentum 30 is a buyable momentum index: beating it is what makes running this strategy worth the effort."
            />
          </span>
          {result.comparisons.map((line) => (
            <span key={line.name} title={line.note ?? undefined}>
              {line.name} {formatPct(line.cagr)} →{' '}
              <b
                className={
                  tone(line.excess_cagr) === 'negative' ? 'text-negative' : 'text-positive'
                }
              >
                {formatPp(line.excess_cagr)}
              </b>
              {line.note ? ' *' : ''}
            </span>
          ))}
        </div>
      ) : null}
      {expanded ? (
        <div className="grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-3 lg:grid-cols-4">
          {detail.map((def) => (
            <Tile key={def.label} def={def} k={k} benchmarkName={b} previous={null} />
          ))}
        </div>
      ) : null}
    </>
  );
}
