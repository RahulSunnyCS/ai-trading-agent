'use client';

import { formatInr, formatNumber, formatPct } from '../../lib/format';
import type { MomentumRun } from '../../store/momentumRuns';
import type { MomentumResult } from '../../types/momentum';
import { StatCard } from '../ui/StatCard';

type Kpis = Record<string, unknown>;

function n(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface KpiDef {
  label: string;
  help: string;
  value: (k: Kpis) => string;
  note?: (k: Kpis) => string;
}

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
    note: () => 'weeks not fully invested',
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

/**
 * The full metric set behind the headline strip's "All metrics" (MomentumHeadline): one tile per
 * metric, with its explanation behind the (i). The headline numbers themselves, which compare
 * against the picked benchmark, are the strip's own.
 */
export function MomentumKpiCards({ result, tax }: { result: MomentumResult; tax: boolean }) {
  const k = result.kpis;
  const detail = tax ? [...DETAIL, TAX_PAID] : DETAIL;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
      {detail.map((def) => (
        <StatCard
          key={def.label}
          label={def.label}
          hint={def.help}
          value={def.value(k)}
          note={def.note?.(k)}
        />
      ))}
    </div>
  );
}
