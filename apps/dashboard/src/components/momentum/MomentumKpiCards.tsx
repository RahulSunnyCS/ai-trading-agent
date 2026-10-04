'use client';

import { formatInr, formatNumber, formatPct, formatPp } from '../../lib/format';
import type { MomentumResult } from '../../types/momentum';
import { InfoTooltip } from '../ui/InfoTooltip';
import { StatCard } from '../ui/StatCard';

type Tone = 'default' | 'positive' | 'negative' | 'muted';

function n(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function tone(value: unknown): Tone {
  const v = n(value);
  if (v === null) return 'default';
  return v > 0 ? 'positive' : v < 0 ? 'negative' : 'default';
}

interface KpiDef {
  label: string;
  help: string;
  value: (k: Record<string, unknown>, benchmark: string) => string;
  note?: (k: Record<string, unknown>, benchmark: string) => string;
  tone?: (k: Record<string, unknown>) => Tone;
}

const HEADLINE: KpiDef[] = [
  {
    label: '₹1 lakh became',
    help: 'Final value of ₹1 lakh invested at the start of the period and left running under this strategy.',
    value: (k) => formatInr(n(k.final_value), { compact: true }),
    note: (k, b) => `${b}: ${formatInr(n(k.benchmark_final_value), { compact: true })}`,
  },
  {
    label: 'CAGR',
    help: 'Compound annual growth rate — the strategy’s average yearly return, smoothed over the whole period.',
    value: (k) => formatPct(n(k.cagr)),
    note: (k, b) => `${b} ${formatPct(n(k.benchmark_cagr))} · cash ${formatPct(n(k.cash_cagr))}`,
  },
  {
    label: 'Edge vs benchmark',
    help: 'How much faster (or slower) the strategy compounded per year than the benchmark — the CAGR gap.',
    value: (k) => formatPp(n(k.excess_cagr)),
    note: (k) => `beat it ${n(k.years_beating_benchmark) ?? '–'} of ${n(k.years) ?? '–'} yrs`,
    tone: (k) => tone(k.excess_cagr),
  },
  {
    label: 'Max drawdown',
    help: 'The worst peak-to-trough fall in portfolio value over the period — how much you’d have been down at the low point.',
    value: (k) => formatPct(n(k.max_drawdown)),
    note: (k, b) => `${b} ${formatPct(n(k.benchmark_max_drawdown))}`,
    tone: () => 'negative',
  },
  {
    label: 'Sharpe / Sortino',
    help: 'Return per unit of risk. Sharpe uses total volatility, Sortino only downside moves — both above 1 are generally considered good, above 2 very good.',
    value: (k) => `${formatNumber(n(k.sharpe))} / ${formatNumber(n(k.sortino))}`,
    note: (k) => `volatility ${formatPct(n(k.volatility))}`,
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

/** Headline KPI tiles, plus the full metric set when `expanded`. Header/toggle live in the caller. */
export function MomentumKpiCards({
  result,
  tax,
  expanded,
}: { result: MomentumResult; tax: boolean; expanded: boolean }) {
  const k = result.kpis;
  const b = result.benchmark_name;
  const detail = tax
    ? [
        ...DETAIL,
        {
          label: 'Tax paid',
          help: 'Capital-gains tax deducted across every sale, including a final sale at period end.',
          value: (kpis: Record<string, unknown>) => formatInr(n(kpis.tax_paid), { compact: true }),
          note: () => 'on ₹1 lakh start',
        } as KpiDef,
      ]
    : DETAIL;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {HEADLINE.map((def) => (
          <StatCard
            key={def.label}
            label={
              <span className="flex items-center gap-1">
                {def.label}
                <InfoTooltip text={def.help} />
              </span>
            }
            value={def.value(k, b)}
            note={def.note?.(k, b)}
            tone={def.tone?.(k) ?? 'default'}
          />
        ))}
      </div>
      {result.comparisons?.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-surface-2/50 px-3 py-2 text-xs text-muted">
          <span className="flex items-center gap-1 font-medium text-foreground">
            Edge vs dividend-inclusive indices
            <InfoTooltip text="Total-return (TRI) indices reinvest dividends, so they are the honest passive alternative. Nifty200 Momentum 30 is a buyable momentum index: beating it is what makes running this strategy worth the effort." />
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
            <StatCard
              key={def.label}
              label={
                <span className="flex items-center gap-1">
                  {def.label}
                  <InfoTooltip text={def.help} />
                </span>
              }
              value={def.value(k, b)}
              note={def.note?.(k, b)}
              tone={def.tone?.(k) ?? 'muted'}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
