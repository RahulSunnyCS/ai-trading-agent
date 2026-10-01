/**
 * Day-level statistics for the Options Lab. Pure functions (no React, no chart
 * library) so they are unit-testable under the dashboard's node vitest env.
 *
 * Everything is in ₹ PER LOT: each day's net is divided by `lots` — the strategy's
 * smallest leg size — so a 1-lot and a 2-lot version of the same idea compare fairly.
 */

import type { DayRow } from '../types/legwise';

/** Below this many days, ratio-style statistics are noise and the UI greys them out. */
export const MIN_DAYS_FOR_RATIOS = 20;

export interface StrategyStats {
  /** Days included. Every other number should be read against this. */
  days: number;
  total: number;
  up: number;
  winRate: number | null;
  avgWin: number | null;
  /** Negative number, or null when there were no losing days. */
  avgLoss: number | null;
  /** Mean ₹ per day. */
  expectancy: number | null;
  /** Sum of wins / |sum of losses|. null with no losses (shown as "—", never ∞). */
  profitFactor: number | null;
  best: number | null;
  worst: number | null;
  longestLosingStreak: number;
  maxDrawdown: number;
  cumulative: { time: string; value: number }[];
  /** True while `days` is under MIN_DAYS_FOR_RATIOS. */
  thin: boolean;
}

export function statsOf(days: Pick<DayRow, 'day' | 'net'>[], lots = 1): StrategyStats {
  const divisor = lots > 0 ? lots : 1;
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const nets = sorted.map((d) => d.net / divisor);

  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let streak = 0;
  let longest = 0;
  const cumulative = sorted.map((d, i) => {
    const net = nets[i] ?? 0;
    running += net;
    peak = Math.max(peak, running);
    maxDrawdown = Math.min(maxDrawdown, running - peak);
    streak = net < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
    return { time: d.day, value: Math.round(running) };
  });

  const wins = nets.filter((n) => n > 0);
  const losses = nets.filter((n) => n < 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const lossSum = sum(losses);
  const n = nets.length;
  return {
    days: n,
    total: running,
    up: wins.length,
    winRate: n ? wins.length / n : null,
    avgWin: wins.length ? sum(wins) / wins.length : null,
    avgLoss: losses.length ? lossSum / losses.length : null,
    expectancy: n ? running / n : null,
    profitFactor: losses.length ? sum(wins) / Math.abs(lossSum) : null,
    best: n ? Math.max(...nets) : null,
    worst: n ? Math.min(...nets) : null,
    longestLosingStreak: longest,
    maxDrawdown,
    cumulative,
    thin: n < MIN_DAYS_FOR_RATIOS,
  };
}

/** A strategy's "one lot": its smallest leg size (a 1-lot-per-leg strategy → 1). */
export function lotsOf(strategy: { legs: { lots: number }[] } | undefined): number {
  if (!strategy || strategy.legs.length === 0) return 1;
  return Math.max(1, Math.min(...strategy.legs.map((l) => l.lots)));
}
