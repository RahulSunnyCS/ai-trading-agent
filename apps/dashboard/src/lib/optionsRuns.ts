/**
 * Options Lab runs and the pieces around them: a saved strategy's History (Strategies and
 * baskets) and the YAML engine's results. Pure functions (no React, no formatting to strings
 * beyond leg descriptions) so they are unit-tested under node. The Runs page that listed both
 * engines together was removed (2026-10-28).
 *
 * The two engines report money differently, so every run carries the unit of its net and the
 * two are never summed or compared with each other:
 *
 *  - YAML engine (GET /api/backtest/runs): one registry row per run. `net_inr` is the TOTAL
 *    over the run's sessions at whatever lot count the strategy pyramided to; the engine
 *    also reports ₹ per lot-day, which is a rate, not a net.
 *  - Leg-wise engine (GET /api/backtest/legwise/results): one row per strategy per day. A
 *    day's `net` is the whole strategy's; dividing by the strategy's smallest leg size gives
 *    ₹ PER LOT (lib/legwiseStats.ts). That divisor is only known for the saved version of a
 *    strategy, so a run of an older version stays a total and says so.
 *
 * What the leg-wise payload offers today: the evening job's saved days only, with
 * `strategy_id`, `strategy_sha` and `day`. It has no run id, no kind and no timestamp, and
 * builder (`adhoc`) runs are stored server-side but not returned. So a leg-wise "run" here is
 * every saved day of one strategy version, dated by its last day. `kind`, `run_id` and
 * `created_at` are read when a row carries them, so builder runs appear once the API sends
 * them.
 */

import type { RunResult, RunSummary, SessionResult } from '../types/backtest';
import type { Leg, SavedResult, SavedStrategy } from '../types/legwise';
import { formatNumber } from './format';
import { type StrategyStats, lotsOf, statsOf } from './legwiseStats';

export type RunKind = 'yaml' | 'builder' | 'daily';
export type NetUnit = 'per_lot' | 'total';

export const RUN_KIND_LABEL: Record<RunKind, string> = {
  yaml: 'YAML',
  builder: 'Builder',
  daily: 'Daily',
};

export const NET_UNIT_LABEL: Record<NetUnit, string> = {
  per_lot: '/ lot',
  total: 'total',
};

/** A leg-wise result row, plus the run fields the API does not send yet. */
export type LegwiseRunRow = SavedResult & {
  kind?: string | undefined;
  run_id?: string | undefined;
  created_at?: string | undefined;
};

export interface OptionsRun {
  /** Unique across both engines; stable between fetches. */
  key: string;
  kind: RunKind;
  strategy: string;
  /** Strategy version: the leg-wise sha, or the YAML engine's spec hash. */
  version: string | null;
  /** When the run was recorded, as an ISO instant. Leg-wise: null unless a row has one. */
  recordedAt: string | null;
  /** First and last day covered, YYYY-MM-DD. */
  from: string;
  to: string;
  /** Milliseconds used for ordering only. */
  sortTime: number;
  net: number;
  netUnit: NetUnit;
  /** Days (sessions) in the run. */
  days: number;
  winDays: number;
  /** Leg-wise only: false when the strategy file has changed since these days were saved. */
  current: boolean | null;
  source:
    | { engine: 'yaml'; run: RunSummary }
    | { engine: 'legwise'; rows: SavedResult[]; lots: number | null };
}

/** A day with no time is ordered as that day's close, 15:30 IST. */
function dayCloseMs(day: string): number {
  const ms = Date.parse(`${day}T10:00:00Z`);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Milliseconds of a recorded-at value. DuckDB casts a timestamp as
 * "2026-10-05 14:35:07.123456+05:30" (or "+00" for UTC), which Date does not reliably read.
 */
function instantMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value
    .trim()
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Leg-wise result rows grouped into runs: by `run_id` when rows carry one, otherwise one
 * run per strategy version. `strategies` supplies the lot divisor for the saved version.
 */
export function legwiseRuns(
  rows: readonly LegwiseRunRow[],
  strategies: readonly SavedStrategy[] = [],
): OptionsRun[] {
  const saved = new Map(strategies.map((s) => [s.strategy.id, s]));
  const groups = new Map<string, LegwiseRunRow[]>();
  for (const row of rows) {
    const kind: RunKind = row.kind === 'adhoc' ? 'builder' : 'daily';
    const id = row.run_id ?? `${row.strategy_id}@${row.strategy_sha}`;
    const key = `${kind}:${id}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const runs: OptionsRun[] = [];
  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => a.day.localeCompare(b.day));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (!first || !last) continue;
    const file = saved.get(first.strategy_id);
    const lots = file && file.sha === first.strategy_sha ? lotsOf(file.strategy) : null;
    const total = sorted.reduce((sum, row) => sum + row.net, 0);
    const recordedMs = instantMs(sorted.map((row) => row.created_at).find((value) => value));
    runs.push({
      key,
      kind: key.startsWith('builder:') ? 'builder' : 'daily',
      strategy: first.strategy_id,
      version: first.strategy_sha || null,
      recordedAt: isoOrNull(recordedMs),
      from: first.day,
      to: last.day,
      sortTime: recordedMs ?? dayCloseMs(last.day),
      net: lots === null ? total : total / lots,
      netUnit: lots === null ? 'total' : 'per_lot',
      days: sorted.length,
      winDays: sorted.filter((row) => row.net > 0).length,
      current: sorted.every((row) => row.current),
      source: { engine: 'legwise', rows: sorted, lots },
    });
  }
  return runs;
}

/**
 * One strategy's saved days, a run per version (Strategies › History, which replaced the Runs
 * page): the saved version first, then older versions, newest last day first. Only the saved
 * version's net is per lot; an older version's lot count is not known, so it stays a total.
 */
export function strategyHistory(
  strategy: SavedStrategy,
  results: readonly LegwiseRunRow[],
): OptionsRun[] {
  const rows = results.filter((row) => row.strategy_id === strategy.strategy.id);
  return legwiseRuns(rows, [strategy]).sort(
    (a, b) =>
      Number(b.version === strategy.sha) - Number(a.version === strategy.sha) ||
      b.to.localeCompare(a.to) ||
      a.key.localeCompare(b.key),
  );
}

/** The leg-wise day statistics of a run, in its own unit (per lot when the divisor is known). */
export function legwiseStatsOf(run: OptionsRun): StrategyStats | null {
  if (run.source.engine !== 'legwise') return null;
  return statsOf(run.source.rows, run.source.lots ?? 1);
}

// ---------------------------------------------------------------------------
// YAML results
// ---------------------------------------------------------------------------

/** The headline figures both a fresh result and a stored registry row can supply. */
export interface YamlHeadline {
  runId: string;
  net: number;
  /** Not kept in the registry: null for a stored run. */
  gross: number | null;
  winDays: number;
  sessions: number;
  worstDay: number;
  sumPeakLoss: number;
  lotDays: number;
  inrPerLotDay: number;
}

export function headlineOfResult(result: RunResult): YamlHeadline {
  return {
    runId: result.run_id,
    net: result.net_inr,
    gross: result.gross_inr,
    winDays: result.win_days,
    sessions: result.sessions.length,
    worstDay: result.worst_day,
    sumPeakLoss: result.sum_peak_loss,
    lotDays: result.lot_days,
    inrPerLotDay: result.inr_per_lot_day,
  };
}

export function headlineOfSummary(run: RunSummary): YamlHeadline {
  return {
    runId: run.run_id,
    net: run.net_inr,
    gross: null,
    winDays: run.win_days,
    sessions: run.n_sessions,
    worstDay: run.worst_day,
    sumPeakLoss: run.sum_peak_loss,
    lotDays: run.lot_days,
    inrPerLotDay: run.inr_per_lot_day,
  };
}

/** Cumulative net by session, oldest first, for the equity chart. */
export function sessionEquity(
  sessions: readonly Pick<SessionResult, 'date' | 'net'>[],
): { time: string; value: number }[] {
  let running = 0;
  return [...sessions]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((session) => {
      running += session.net;
      return { time: session.date, value: Math.round(running) };
    });
}

/** The first and last day any cached timeframe covers, or null when nothing is cached. */
export function coverageRange(
  coverage: Record<string, { start: string; end: string }> | null | undefined,
): { from: string; to: string } | null {
  const ranges = Object.values(coverage ?? {}).filter((range) => range.start && range.end);
  if (ranges.length === 0) return null;
  return {
    from: ranges.map((range) => range.start).sort()[0] as string,
    to: ranges.map((range) => range.end).sort()[ranges.length - 1] as string,
  };
}

/** Why Run is unavailable, or null when it can run. The first reason that applies. */
export function runBlockedReason(input: {
  yaml: string;
  validating: boolean;
  valid: boolean | null;
  errorCount: number;
  validationError: string | null;
  from: string;
  to: string;
}): string | null {
  if (input.yaml.trim() === '') return 'Pick a preset or paste a strategy first.';
  if (input.validationError !== null) return 'The strategy could not be validated.';
  if (input.validating || input.valid === null) return 'Checking the strategy…';
  if (!input.valid) {
    return `Fix the ${input.errorCount === 1 ? 'validation error' : `${input.errorCount} validation errors`} first.`;
  }
  if (input.from === '' && input.to === '') return 'Choose a From and a To date.';
  if (input.from === '') return 'Choose a From date.';
  if (input.to === '') return 'Choose a To date.';
  if (input.from > input.to) return 'From is after To.';
  return null;
}

// ---------------------------------------------------------------------------
// Saved strategies
// ---------------------------------------------------------------------------

/** One leg in a few words: "Sell CE ITM1", "2 lots Buy PE ₹50 premium". */
export function describeLeg(leg: Leg): string {
  const side = leg.position === 'buy' ? 'Buy' : 'Sell';
  const strike =
    leg.strike.strike_type ??
    (leg.strike.closest_premium !== undefined
      ? `₹${formatNumber(leg.strike.closest_premium, 2, { trim: true })} premium`
      : '');
  const lots = leg.lots > 1 ? `${leg.lots} lots ` : '';
  return `${lots}${side} ${leg.option_type} ${strike}`.trim();
}

/** Leg count and a compact description of each leg, in the strategy's order. */
export function legsSummary(legs: readonly Leg[]): { count: number; text: string } {
  return { count: legs.length, text: legs.map(describeLeg).join(' · ') };
}

export interface StrategyLastResult {
  /** ₹ per lot over `days` saved days of the saved version. */
  netPerLot: number;
  days: number;
  upDays: number;
  lastDay: string;
}

/** What the evening job has saved for the current version of a strategy, or null. */
export function lastResultOf(
  strategy: SavedStrategy,
  results: readonly SavedResult[],
): StrategyLastResult | null {
  const rows = results.filter(
    (row) => row.strategy_id === strategy.strategy.id && row.strategy_sha === strategy.sha,
  );
  if (rows.length === 0) return null;
  const stats = statsOf(rows, lotsOf(strategy.strategy));
  return {
    netPerLot: stats.total,
    days: stats.days,
    upDays: stats.up,
    lastDay: rows.map((row) => row.day).sort()[rows.length - 1] as string,
  };
}
