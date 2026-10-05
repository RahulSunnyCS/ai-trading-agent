/**
 * Pure helpers for Data › Coverage (Backfill and Replay): which rows are replayable, when the
 * status table polls, how far an interrupted job got, the trigger form's IST date defaults and
 * validation, and the one label map for symbols and resolutions that both the form and the
 * tables read, so an option and the row it produces say the same thing.
 */

import type { BackfillRangeRow, BackfillStatus } from '../types/trading';

/**
 * Whether a backfill range in each status has its candles written and can be replayed.
 * Keyed by the full status union so a status added to the API fails typecheck here.
 */
export const REPLAYABLE_BY_STATUS: Record<BackfillStatus, boolean> = {
  completed: true,
  in_progress: false,
  failed: false,
};

export function isReplayable(row: Pick<BackfillRangeRow, 'status'>): boolean {
  return REPLAYABLE_BY_STATUS[row.status] === true;
}

// ---------------------------------------------------------------------------
// Polling and progress
// ---------------------------------------------------------------------------

/** How often the status table re-reads GET /api/backfill while a job is running. */
export const BACKFILL_POLL_MS = 5_000;

/**
 * Poll while any row is in progress, or until `watchUntil` (epoch ms) has passed: a job just
 * queued has no row until the worker picks it up, so the view watches for it for a while.
 */
export function shouldPollBackfill(
  ranges: ReadonlyArray<Pick<BackfillRangeRow, 'status'>>,
  watchUntil: number | null,
  now: number,
): boolean {
  if (ranges.some((row) => row.status === 'in_progress')) return true;
  return watchUntil !== null && now < watchUntil;
}

function epochMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * How far through its range a job is, from `checkpoint_ts` (the last candle written) between
 * `from_ts` and `to_ts`, as a fraction clamped to [0, 1]. Null when there is no checkpoint, a
 * date does not parse, or the range is empty. The server records a checkpoint only when a run
 * is interrupted, so a fresh running job has none and the view shows it as indeterminate.
 */
export function backfillProgress(
  row: Pick<BackfillRangeRow, 'from_ts' | 'to_ts' | 'checkpoint_ts'>,
): number | null {
  const from = epochMs(row.from_ts);
  const to = epochMs(row.to_ts);
  const checkpoint = epochMs(row.checkpoint_ts);
  if (from === null || to === null || checkpoint === null || to <= from) return null;
  return Math.min(1, Math.max(0, (checkpoint - from) / (to - from)));
}

// ---------------------------------------------------------------------------
// Trigger form: IST date defaults and validation
// ---------------------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function parseDay(day: string): number | null {
  if (!ISO_DAY.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  // Date.parse rolls 2026-02-31 over to March; reject a day that does not round-trip.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return null;
  return ms;
}

/** `day` ("YYYY-MM-DD") moved by `days` calendar days. Time-zone free. */
export function shiftDay(day: string, days: number): string {
  const ms = parseDay(day);
  if (ms === null) return day;
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The form's opening range: the seven days up to yesterday, counted from `today`, which is the
 * IST date (`istToday()`). Counting from the UTC date put both ends a day early before 05:30 IST.
 */
export function defaultBackfillRange(today: string): { from: string; to: string } {
  return { from: shiftDay(today, -7), to: shiftDay(today, -1) };
}

/** Why a from/to pair cannot be queued, or null when it can. `today` is the IST date. */
export function validateBackfillRange(from: string, to: string, today: string): string | null {
  const fromMs = parseDay(from);
  const toMs = parseDay(to);
  if (fromMs === null) return 'Choose a valid From date';
  if (toMs === null) return 'Choose a valid To date';
  if (fromMs > toMs) return 'From must be on or before To';
  const todayMs = parseDay(today);
  if (todayMs !== null && toMs > todayMs) return 'To cannot be in the future';
  return null;
}

// ---------------------------------------------------------------------------
// Shared label maps
// ---------------------------------------------------------------------------

interface SymbolMeta {
  /** What the dashboard calls it. */
  label: string;
  /** The `--underlying` name `bun run replay` accepts (NIFTY | BANKNIFTY | SENSEX). */
  underlying: string;
}

/** Fyers index symbol -> display label and replay underlying. */
const SYMBOL_META: Readonly<Record<string, SymbolMeta>> = {
  'NSE:NIFTY50-INDEX': { label: 'NIFTY', underlying: 'NIFTY' },
  'NSE:NIFTYBANK-INDEX': { label: 'BankNifty', underlying: 'BANKNIFTY' },
  'BSE:SENSEX-INDEX': { label: 'Sensex', underlying: 'SENSEX' },
};

/**
 * The symbols the trigger form offers. Must match BACKFILL_SUPPORTED_SYMBOLS on the server
 * (apps/server/src/ingestion/brokers/types.ts): POST /api/backfill rejects anything else.
 */
export const BACKFILL_SYMBOLS = ['NSE:NIFTY50-INDEX', 'BSE:SENSEX-INDEX'] as const;

/** "NIFTY" for "NSE:NIFTY50-INDEX"; an unknown symbol is shown as it is. */
export function symbolLabel(symbol: string): string {
  return SYMBOL_META[symbol]?.label ?? symbol;
}

/** The resolutions the trigger form offers, in order. */
export const BACKFILL_RESOLUTIONS = ['1', '5', '15', 'D', 'W'] as const;

const NAMED_RESOLUTIONS: Readonly<Record<string, string>> = {
  D: 'Daily',
  W: 'Weekly',
  M: 'Monthly',
};

/** "1-min", "1-hour", "Daily" for a Fyers resolution code; an unknown code is shown as it is. */
export function resolutionLabel(code: string): string {
  const named = NAMED_RESOLUTIONS[code];
  if (named) return named;
  if (!/^\d+$/.test(code)) return code;
  const minutes = Number(code);
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-min`;
}

// ---------------------------------------------------------------------------
// Replay commands
// ---------------------------------------------------------------------------

export type ReplayMode = 'dry-run' | 'against-live';

/** One `bun run replay` command line. The how-to and every coverage row go through this. */
export function replayCommand(args: {
  from: string;
  to: string;
  underlying: string;
  mode: ReplayMode;
}): string {
  return `bun run replay --from ${args.from} --to ${args.to} --underlying ${args.underlying} --${args.mode}`;
}

/**
 * The dry-run replay for a backfilled range, or null when its symbol is not one the replay
 * CLI knows. The CLI takes the underlying's name (NIFTY), not the Fyers symbol.
 */
export function rowReplayCommand(
  row: Pick<BackfillRangeRow, 'symbol' | 'from_ts' | 'to_ts'>,
): string | null {
  const underlying = SYMBOL_META[row.symbol]?.underlying;
  if (!underlying) return null;
  return replayCommand({ from: row.from_ts, to: row.to_ts, underlying, mode: 'dry-run' });
}
