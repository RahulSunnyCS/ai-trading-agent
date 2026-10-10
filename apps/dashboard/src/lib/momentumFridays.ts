import type { MomentumFridaySpread } from '../types/momentum';

/** A run is an "All Fridays" run only where the flag does something: a weekly cadence of 2+. */
export function isAllFridays(config: Record<string, unknown>): boolean {
  const every = Number(config.rebalance_every ?? 1);
  return (
    config.split_fridays === true &&
    config.rebalance !== 'monthly' &&
    Number.isFinite(every) &&
    every > 1
  );
}

export interface FridayRow {
  /** 0-based calendar phase, or null for the whole account. */
  offset: number | null;
  label: string;
  cagr: number;
  maxDrawdown: number;
  ulcer: number;
  /** CAGR minus the whole account's, as a fraction. 0 for the whole-account row. */
  gap: number;
}

export interface FridayLuck {
  rows: FridayRow[];
  best: FridayRow;
  worst: FridayRow;
  /** Best minus worst single-Friday CAGR, as a fraction. */
  spread: number;
}

/** The Friday-luck table: one row per Friday (1-based in the label), then the whole account. */
export function fridayLuck(spread: MomentumFridaySpread): FridayLuck | null {
  if (spread.phases.length === 0) return null;
  const rows: FridayRow[] = spread.phases.map((phase) => ({
    offset: phase.offset,
    label: `Friday ${phase.offset + 1} of ${spread.every}`,
    cagr: phase.cagr,
    maxDrawdown: phase.max_drawdown,
    ulcer: phase.ulcer,
    gap: phase.cagr - spread.blend.cagr,
  }));
  const ordered = [...rows].sort((a, b) => a.cagr - b.cagr);
  const worst = ordered[0] as FridayRow;
  const best = ordered[ordered.length - 1] as FridayRow;
  rows.push({
    offset: null,
    label: 'All Fridays (split)',
    cagr: spread.blend.cagr,
    maxDrawdown: spread.blend.max_drawdown,
    ulcer: spread.blend.ulcer,
    gap: 0,
  });
  return { rows, best, worst, spread: best.cagr - worst.cagr };
}
