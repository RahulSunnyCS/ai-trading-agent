/**
 * Pure derivations for the Overview home (components/OverviewView.tsx): what the tick feed's
 * state means right now, and one-line summaries of the weekly momentum signal and the Options
 * Lab evening job. No React and no fetching, so each rule is unit-tested on its own.
 */

import type { DailyJob } from '../types/legwise';
import type { MomentumWeeklyJob, MomentumWeeklyStatus } from '../types/momentum';
import { formatInt, formatRelative } from './format';

// ---------------------------------------------------------------------------
// Tick feed
// ---------------------------------------------------------------------------

/**
 * A feed that should be ticking counts as stale once its last tick is older than this.
 * Index ticks arrive about every second and the straddle snapshot every 15 s; this is three
 * missed snapshots.
 */
export const FEED_STALE_AFTER_MS = 45_000;

export type FeedConnection = 'connecting' | 'connected' | 'disconnected';

/**
 * - `live`: connected and a tick arrived within FEED_STALE_AFTER_MS.
 * - `stale`: connected, ticks are expected, and the last one is older than that.
 * - `waiting`: connected, ticks are expected, none has arrived on this connection yet.
 * - `idle`: connected, but the market is closed, so silence is normal.
 * - `connecting` / `disconnected`: the socket itself is not up.
 */
export type FeedHealth = 'live' | 'stale' | 'waiting' | 'idle' | 'connecting' | 'disconnected';

export interface FeedHealthInput {
  connection: FeedConnection;
  /** Epoch ms of the last tick, or null when none has arrived. */
  lastTickAt: number | null;
  /** Epoch ms. */
  now: number;
  /** The exchange session is open (not pre-open, not closed). */
  marketOpen: boolean;
  /** The server runs its simulator, which ticks around the clock. */
  simulate: boolean;
}

export function feedHealth(input: FeedHealthInput): FeedHealth {
  const { connection, lastTickAt, now, marketOpen, simulate } = input;
  if (connection !== 'connected') return connection;
  if (lastTickAt !== null && now - lastTickAt <= FEED_STALE_AFTER_MS) return 'live';
  if (marketOpen || simulate) return lastTickAt === null ? 'waiting' : 'stale';
  return 'idle';
}

// ---------------------------------------------------------------------------
// Weekly momentum signal
// ---------------------------------------------------------------------------

export interface WeeklyActionCounts {
  buys: number;
  sells: number;
  holds: number;
}

/**
 * Counts a signal's rows by what they ask for, using the Momentum service's action words:
 * "BUY…" / "ADD…" are buys, "SELL…" sells, "HOLD" and "AT CAP" holds; blank and "WAIT" rows
 * are not positions and are skipped. Null when `rows` is not a list of signal rows at all.
 */
export function countWeeklyActions(rows: unknown): WeeklyActionCounts | null {
  if (!Array.isArray(rows)) return null;
  const counts: WeeklyActionCounts = { buys: 0, sells: 0, holds: 0 };
  let recognised = false;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const raw = (row as { action?: unknown }).action;
    if (typeof raw !== 'string') continue;
    recognised = true;
    const action = raw.trim().toUpperCase();
    if (action.startsWith('BUY') || action.startsWith('ADD')) counts.buys += 1;
    else if (action.startsWith('SELL')) counts.sells += 1;
    else if (action === 'HOLD' || action === 'AT CAP') counts.holds += 1;
  }
  return recognised ? counts : null;
}

function plural(count: number, one: string, many: string): string {
  return `${formatInt(count)} ${count === 1 ? one : many}`;
}

/** "2 buys · 1 sell · 3 holds"; kinds with a zero count are left out. */
export function describeWeeklyActions(counts: WeeklyActionCounts): string {
  const parts = [
    counts.buys > 0 ? plural(counts.buys, 'buy', 'buys') : null,
    counts.sells > 0 ? plural(counts.sells, 'sell', 'sells') : null,
    counts.holds > 0 ? plural(counts.holds, 'hold', 'holds') : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : 'No positions indicated';
}

/**
 * The signal rows behind the final signal for `week`, when the latest manual run produced
 * them: the weekly status lists saved signals without their rows, so the only place they are
 * available is a finished final run's result (the Telegram-active strategy's, else the run's
 * own). Null for a preview, a failed or running job, another week, or no job.
 */
export function weeklySignalRows(job: MomentumWeeklyJob | null, week: string): unknown {
  if (!job || job.status !== 'done' || job.run !== 'final' || !job.result) return null;
  const strategies = job.result.strategies ?? [];
  const signal =
    strategies.find((strategy) => strategy.active && !strategy.blocked)?.signal ??
    (strategies.length === 0 ? job.result.signal : null);
  if (!signal) return null;
  const signalWeek = typeof signal.week === 'string' ? signal.week.slice(0, 10) : null;
  return signalWeek === week.slice(0, 10) ? (signal.rows ?? null) : null;
}

/**
 * The supporting line under the signal's week: the strategy, then its actions when the rows
 * are known ("ETF Weekly Core · 2 buys · 1 sell"), otherwise the strategy alone.
 */
export function weeklySignalSummary(strategyName: string, rows: unknown): string {
  const counts = countWeeklyActions(rows);
  return counts ? `${strategyName} · ${describeWeeklyActions(counts)}` : strategyName;
}

/**
 * When the signal runs next, from the schedule the status reports: "Next runs: preview Fri
 * 14:40 IST · final Fri 16:45 IST". The payload gives each run's schedule as text, not as a
 * timestamp, so this repeats it rather than computing a date. Null when there is none.
 */
export function weeklyScheduleLine(
  schedule: MomentumWeeklyStatus['schedule'] | null | undefined,
): string | null {
  const runs = (schedule ?? []).filter(
    (item) => (item.run === 'preview' || item.run === 'final') && item.when.trim() !== '',
  );
  if (runs.length === 0) return null;
  return `Next runs: ${runs.map((item) => `${item.run} ${item.when.trim()}`).join(' · ')}`;
}

// ---------------------------------------------------------------------------
// Options Lab evening job
// ---------------------------------------------------------------------------

/**
 * What the evening job is doing, in a few words: "evening run in progress", "last run 3 h
 * ago", "last run failed 3 h ago", or "no evening run since the service started" (the job's
 * state lives in the service's memory and does not survive a restart).
 */
export function eveningJobLine(job: DailyJob, now: Date | number = Date.now()): string {
  if (job.state === 'running') return 'evening run in progress';
  if (job.state === 'idle' || !job.finished) return 'no evening run since the service started';
  const when = formatRelative(job.finished, now);
  return job.state === 'failed' ? `last run failed ${when}` : `last run ${when}`;
}
