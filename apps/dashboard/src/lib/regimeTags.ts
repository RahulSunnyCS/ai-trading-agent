/**
 * Pure derivations for the Regimes trading tab (components/RegimeView.tsx +
 * components/regime/): the window the tags are fetched for, the day strip, the share of days
 * per regime, and paper-trade P&L joined to the regime of each trade's exit day.
 *
 * Days are IST calendar days as "YYYY-MM-DD" strings throughout. Labels, tones and glyphs are
 * not here: they come from lib/regimeMeta.ts, the one regime vocabulary.
 */

import type { PaperTrade, RegimeTag } from '../types/trading';
import { istToday, toNumberOrNull } from './format';
import { TRADING_REGIMES, normaliseRegimeKey } from './regimeMeta';

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAIN_DAY = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The windows the filter bar offers, in days. */
export const REGIME_WINDOWS = [30, 90, 180] as const;
export type RegimeWindow = (typeof REGIME_WINDOWS)[number];

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/**
 * The IST trading day an API date or timestamp falls on, or null when it does not parse.
 * `daily_regime_tags.trade_date` is a DATE that pg turns into the server's local midnight, so
 * it arrives as "…T00:00:00.000Z" from a UTC server and "…T18:30:00.000Z" (the day before, in
 * UTC) from an IST one; reading the instant in IST gives the right day for either.
 */
export function istDay(value: string | null | undefined): string | null {
  if (!value) return null;
  if (PLAIN_DAY.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : istToday(date);
}

/** "2026-10-05" plus `n` calendar days. */
export function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  return new Date(date.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** "Mon" … "Sun" for a calendar day. */
export function weekdayOf(day: string): string {
  return WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? '';
}

function isWeekday(day: string): boolean {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/**
 * The `from` / `to` query for the last `days` days ending today in IST, both inclusive (the
 * same shape as the endpoint's own 30-day default; it caps a range at 366 days).
 */
export function windowRange(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = istToday(now);
  return { from: addDays(to, -days), to };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface DayRegime {
  day: string;
  /** Upper-snake regime key ('RANGING', …). */
  regime: string;
  /** 0–1, or null when absent. */
  confidence: number | null;
  classifiedAt: string;
}

/** Tags as one entry per IST day, oldest first. A later row for the same day wins. */
export function dayRegimes(tags: readonly RegimeTag[]): DayRegime[] {
  const byDay = new Map<string, DayRegime>();
  for (const tag of tags) {
    const day = istDay(tag.trade_date);
    if (day === null) continue;
    byDay.set(day, {
      day,
      regime: normaliseRegimeKey(tag.regime),
      confidence: toNumberOrNull(tag.regime_confidence),
      classifiedAt: tag.classified_at,
    });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export interface StripCell {
  day: string;
  weekday: string;
  /** Null for a weekday with no tag (an exchange holiday, or a day the tagger did not run). */
  tag: DayRegime | null;
}

/**
 * One cell per weekday from the first tagged day to the last, so a missing tag shows as a gap
 * rather than silently closing up. Weekends are left out; holidays are not known here and
 * show as untagged weekdays.
 */
export function stripCells(days: readonly DayRegime[]): StripCell[] {
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return [];
  const byDay = new Map(days.map((d) => [d.day, d]));
  const cells: StripCell[] = [];
  for (let day = first.day; day <= last.day; day = addDays(day, 1)) {
    const tag = byDay.get(day) ?? null;
    if (tag === null && !isWeekday(day)) continue;
    cells.push({ day, weekday: weekdayOf(day), tag });
  }
  return cells;
}

/** The order regimes are listed in: the tagger's precedence, then Unclassified, then others. */
function regimeOrder(key: string): number {
  const index = (TRADING_REGIMES as readonly string[]).indexOf(key);
  if (index >= 0) return index;
  if (key === 'UNCLASSIFIED') return TRADING_REGIMES.length;
  if (key === '') return TRADING_REGIMES.length + 2;
  return TRADING_REGIMES.length + 1;
}

function byRegimeOrder(a: string, b: string): number {
  return regimeOrder(a) - regimeOrder(b) || a.localeCompare(b);
}

export interface RegimeShare {
  regime: string;
  days: number;
  /** 0–1 of all tagged days in the window. */
  share: number;
}

/**
 * Days per regime and their share of the tagged days. Every regime the live tagger can
 * assign is listed, at zero when absent; Unclassified and unknown keys only when present.
 */
export function regimeDistribution(days: readonly DayRegime[]): {
  total: number;
  rows: RegimeShare[];
} {
  const counts = new Map<string, number>(TRADING_REGIMES.map((key) => [key, 0]));
  for (const d of days) counts.set(d.regime, (counts.get(d.regime) ?? 0) + 1);
  const total = days.length;
  const rows = [...counts.entries()]
    .sort((a, b) => byRegimeOrder(a[0], b[0]))
    .map(([regime, n]) => ({ regime, days: n, share: total > 0 ? n / total : 0 }));
  return { total, rows };
}

/** The regimes present in the data, in list order (for the regime filter). */
export function presentRegimes(days: readonly DayRegime[]): string[] {
  return [...new Set(days.map((d) => d.regime))].sort(byRegimeOrder);
}

// ---------------------------------------------------------------------------
// Underlyings
// ---------------------------------------------------------------------------

/** paper_trades.symbol / daily_regime_tags.symbol hold the underlying ("NIFTY"). */
function underlyingOf(symbol: unknown): string | null {
  return typeof symbol === 'string' && symbol.trim() !== '' ? symbol.trim().toUpperCase() : null;
}

/**
 * The underlyings the filter can offer: the current one, every one the tags carry, and every
 * one the paper trades were taken on (the API has no list of tagged underlyings).
 */
export function underlyingOptions(
  current: string,
  tags: readonly RegimeTag[],
  trades: readonly PaperTrade[],
): string[] {
  const set = new Set<string>([current.toUpperCase()]);
  for (const tag of tags) {
    const u = underlyingOf(tag.symbol);
    if (u) set.add(u);
  }
  for (const trade of trades) {
    const u = underlyingOf(trade.symbol);
    if (u) set.add(u);
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// P&L by regime
// ---------------------------------------------------------------------------

export interface RegimePnlRow {
  /** Regime key; '' for closed trades whose exit day has no tag. */
  regime: string;
  trades: number;
  wins: number;
  /** Sum of net_pnl, ₹. */
  netPnl: number;
}

export interface RegimePnl {
  rows: RegimePnlRow[];
  /** Closed trades on this underlying that exited inside the window. */
  joined: number;
  /** Of those, how many fell on a day with no tag (they are in the '' row). */
  untagged: number;
  /** Closed trades in the window left out because net_pnl is missing or not a number. */
  missingPnl: number;
}

/**
 * Closed paper trades on `underlying` that exited between `from` and `to` (IST days,
 * inclusive), grouped by the regime of their exit day. Open trades are left out, and so is a
 * trade with no usable net P&L (counted in `missingPnl`, never summed as zero). Sums are
 * plain numbers, for display, the same as lib/pnl.ts (the dashboard carries no decimal.js).
 */
export function pnlByRegime(
  trades: readonly PaperTrade[],
  days: readonly DayRegime[],
  options: { underlying: string; from: string; to: string },
): RegimePnl {
  const regimeOn = new Map(days.map((d) => [d.day, d.regime]));
  const want = options.underlying.toUpperCase();
  const rows = new Map<string, RegimePnlRow>();
  let joined = 0;
  let untagged = 0;
  let missingPnl = 0;

  for (const trade of trades) {
    if (trade.status !== 'closed') continue;
    const symbol = underlyingOf(trade.symbol);
    // A row without a symbol (fixtures, older payloads) can only be the default, NIFTY.
    if ((symbol ?? 'NIFTY') !== want) continue;
    const day = istDay(trade.exit_time);
    if (day === null || day < options.from || day > options.to) continue;
    const pnl = toNumberOrNull(trade.net_pnl);
    if (pnl === null) {
      missingPnl += 1;
      continue;
    }
    const regime = regimeOn.get(day) ?? '';
    if (regime === '') untagged += 1;
    joined += 1;
    const row = rows.get(regime) ?? { regime, trades: 0, wins: 0, netPnl: 0 };
    row.trades += 1;
    if (pnl > 0) row.wins += 1;
    row.netPnl += pnl;
    rows.set(regime, row);
  }

  return {
    rows: [...rows.values()].sort((a, b) => byRegimeOrder(a.regime, b.regime)),
    joined,
    untagged,
    missingPnl,
  };
}
