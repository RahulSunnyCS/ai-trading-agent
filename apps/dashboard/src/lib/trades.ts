/**
 * Pure helpers for the Trades tab: URL filter parsing, filtering, the row model the table
 * renders, sorting, the exit-reason vocabulary and the CSV export. No React, no fetch.
 *
 * Every derived figure comes from fields GET /api/trades already returns (`SELECT *` from
 * paper_trades); nothing here invents a value the row does not carry.
 */

import type { PaperTrade, Personality } from '../types/trading';
import { formatDuration, formatInt, formatIstTime, istToday, toNumberOrNull } from './format';

// ---------------------------------------------------------------------------
// Filters (persisted in the query string: ?status=open&personality=<id>&from=…&to=…)
// ---------------------------------------------------------------------------

export const TRADE_STATUS_FILTERS = ['all', 'open', 'closed'] as const;
export type TradeStatusFilter = (typeof TRADE_STATUS_FILTERS)[number];

/** The personality filter value for trades with no personality_id (pre-M2 trades). */
export const NO_PERSONALITY = 'none';

export interface TradeFilters {
  status: TradeStatusFilter;
  /** A personality_configs.id, NO_PERSONALITY, or null for every personality. */
  personality: string | null;
  /** Inclusive IST entry day, YYYY-MM-DD, or null for open-ended. */
  from: string | null;
  to: string | null;
}

export function parseStatusFilter(raw: string | null | undefined): TradeStatusFilter {
  return TRADE_STATUS_FILTERS.find((status) => status === raw) ?? 'all';
}

/** A query-string day: kept only when it is a real YYYY-MM-DD calendar date. */
export function parseDayParam(raw: string | null | undefined): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : null;
}

/** True when `from` is after `to` (the range then matches nothing). */
export function isRangeInverted(filters: Pick<TradeFilters, 'from' | 'to'>): boolean {
  return filters.from !== null && filters.to !== null && filters.from > filters.to;
}

export function hasActiveFilters(filters: TradeFilters): boolean {
  return (
    filters.status !== 'all' ||
    filters.personality !== null ||
    filters.from !== null ||
    filters.to !== null
  );
}

/** The IST calendar day a trade was entered, or null when entry_time does not parse. */
export function tradeEntryDay(trade: Pick<PaperTrade, 'entry_time'>): string | null {
  const date = new Date(trade.entry_time);
  return Number.isNaN(date.getTime()) ? null : istToday(date);
}

/** The trades that match every active filter, in input order. */
export function filterTrades(trades: readonly PaperTrade[], filters: TradeFilters): PaperTrade[] {
  if (isRangeInverted(filters)) return [];
  return trades.filter((trade) => {
    if (filters.status !== 'all' && trade.status !== filters.status) return false;
    if (filters.personality !== null) {
      const id = trade.personality_id ?? null;
      if (filters.personality === NO_PERSONALITY ? id !== null : id !== filters.personality) {
        return false;
      }
    }
    if (filters.from !== null || filters.to !== null) {
      const day = tradeEntryDay(trade);
      if (day === null) return false;
      if (filters.from !== null && day < filters.from) return false;
      if (filters.to !== null && day > filters.to) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Exit reasons
// ---------------------------------------------------------------------------

/**
 * Every exit reason the server writes, keyed upper snake case. The engine's triggers
 * (trigger-engine.ts) write SL / TSL / TARGET / EOD / DAILY_LOSS / EXIT_WINDOW; the Adjuster
 * and Reducer add ROLL and CUT; the column's CHECK constraint also allows TIME,
 * DAILY_LOSS_CAP and MANUAL; the M1 trigger-exit.ts used lower-case names (stop_loss,
 * target_reached, …).
 */
export const EXIT_REASON_LABELS: Readonly<Record<string, string>> = {
  SL: 'Stop-loss',
  STOP_LOSS: 'Stop-loss',
  TSL: 'Trailing stop',
  TRAILING_STOP_LOSS: 'Trailing stop',
  TARGET: 'Target hit',
  TARGET_REACHED: 'Target hit',
  EOD: 'End of day',
  EOD_EXIT: 'End of day',
  TIME: 'Time exit',
  TIME_EXIT: 'Time exit',
  EXIT_WINDOW: 'Exit window',
  DAILY_LOSS: 'Daily loss cap',
  DAILY_LOSS_CAP: 'Daily loss cap',
  ROLL: 'Rolled',
  CUT: 'Cut (re-enter)',
  MANUAL: 'Manual',
};

/** A readable label for a raw exit reason; an unknown code is humanised, null is "". */
export function exitReasonLabel(raw: string | null | undefined): string {
  const key = (raw ?? '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();
  if (key === '') return '';
  const known = EXIT_REASON_LABELS[key];
  if (known) return known;
  const words = key.replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

/** What a trade with no (or an unknown) personality is called. */
export const UNASSIGNED_LABEL = 'Unassigned';

export interface TradeRow {
  trade: PaperTrade;
  id: string;
  status: PaperTrade['status'];
  personalityId: string | null;
  personalityName: string;
  symbol: string | null;
  strike: number | null;
  expiry: string | null;
  entryTime: string;
  exitTime: string | null;
  /** exit − entry in ms; null while open or when either time does not parse. */
  durationMs: number | null;
  lots: number | null;
  lotSize: number | null;
  /** lots × lot size (contracts per leg). */
  quantity: number | null;
  straddleAtEntry: number | null;
  grossPnl: number | null;
  netPnl: number | null;
  /** Net P&L as a fraction of the premium collected — see pnlPctOfPremium. */
  pnlPct: number | null;
  exitReason: string | null;
  exitReasonLabel: string;
  regime: string | null;
  vixAtEntry: number | null;
}

/** personality id → display name (falls back to `name`). */
export function personalityNames(personalities: readonly Personality[]): Map<string, string> {
  return new Map(personalities.map((p) => [p.id, p.display_name || p.name]));
}

function finiteInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The premium a short straddle collected: straddle at entry × lots × lot size, in ₹. */
export function premiumCollected(
  trade: Pick<PaperTrade, 'straddle_at_entry' | 'lots' | 'lot_size'>,
): number | null {
  const straddle = toNumberOrNull(trade.straddle_at_entry);
  const lots = finiteInt(trade.lots);
  const lotSize = finiteInt(trade.lot_size);
  if (straddle === null || lots === null || lotSize === null) return null;
  const premium = straddle * lots * lotSize;
  return premium > 0 ? premium : null;
}

/**
 * P&L % of premium collected: net_pnl ÷ (straddle_at_entry × lots × lot_size), as a fraction
 * (0.065 = 6.5 %). For a short straddle this is how much of the premium sold was kept (or, when
 * negative, lost). Null while open, or when the row lacks any of the inputs.
 */
export function pnlPctOfPremium(
  trade: Pick<PaperTrade, 'net_pnl' | 'straddle_at_entry' | 'lots' | 'lot_size'>,
): number | null {
  const net = toNumberOrNull(trade.net_pnl);
  const premium = premiumCollected(trade);
  return net === null || premium === null ? null : net / premium;
}

function durationBetween(entry: string, exit: string | null): number | null {
  if (exit === null) return null;
  const ms = new Date(exit).getTime() - new Date(entry).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function toTradeRow(trade: PaperTrade, names: ReadonlyMap<string, string>): TradeRow {
  const personalityId = trade.personality_id ?? null;
  const lots = finiteInt(trade.lots);
  const lotSize = finiteInt(trade.lot_size);
  const exitReason = trade.exit_reason ?? null;
  return {
    trade,
    id: trade.id,
    status: trade.status,
    personalityId,
    personalityName:
      personalityId === null ? UNASSIGNED_LABEL : (names.get(personalityId) ?? UNASSIGNED_LABEL),
    symbol: trade.symbol ?? null,
    strike: toNumberOrNull(trade.strike),
    expiry: trade.expiry ?? null,
    entryTime: trade.entry_time,
    exitTime: trade.exit_time,
    durationMs: durationBetween(trade.entry_time, trade.exit_time),
    lots,
    lotSize,
    quantity: lots !== null && lotSize !== null ? lots * lotSize : null,
    straddleAtEntry: toNumberOrNull(trade.straddle_at_entry),
    grossPnl: toNumberOrNull(trade.gross_pnl),
    netPnl: toNumberOrNull(trade.net_pnl),
    pnlPct: pnlPctOfPremium(trade),
    exitReason,
    exitReasonLabel: exitReasonLabel(exitReason),
    regime: trade.market_regime ?? null,
    vixAtEntry: toNumberOrNull(trade.vix_at_entry),
  };
}

export function toTradeRows(
  trades: readonly PaperTrade[],
  personalities: readonly Personality[],
): TradeRow[] {
  const names = personalityNames(personalities);
  return trades.map((trade) => toTradeRow(trade, names));
}

/** Which optional columns any row has data for, so an all-empty column can be left out. */
export function optionalColumns(rows: readonly TradeRow[]): {
  contract: boolean;
  regime: boolean;
  vix: boolean;
} {
  return {
    contract: rows.some((r) => r.symbol !== null || r.strike !== null || r.expiry !== null),
    regime: rows.some((r) => r.regime !== null),
    vix: rows.some((r) => r.vixAtEntry !== null),
  };
}

/** A whole-trade holding time: "37s", "12m 05s" under an hour, then "2h 30m". */
export function formatHoldTime(ms: number | null): string {
  if (ms === null || ms < 3_600_000) return formatDuration(ms);
  const minutes = Math.round(ms / 60_000);
  return `${formatInt(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type TradeSortKey =
  | 'personality'
  | 'status'
  | 'contract'
  | 'entry'
  | 'exit'
  | 'quantity'
  | 'straddle'
  | 'net'
  | 'pnlPct'
  | 'reason'
  | 'regime'
  | 'vix';

export interface TradeSort {
  key: TradeSortKey;
  dir: 'asc' | 'desc';
}

/** Newest entry first, as the API returns them. */
export const DEFAULT_TRADE_SORT: TradeSort = { key: 'entry', dir: 'desc' };

const TEXT_KEYS: ReadonlySet<TradeSortKey> = new Set([
  'personality',
  'status',
  'contract',
  'reason',
  'regime',
]);

function timeOf(iso: string | null): number | null {
  if (iso === null) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function sortValue(row: TradeRow, key: TradeSortKey): number | string | null {
  switch (key) {
    case 'personality':
      return row.personalityName;
    case 'status':
      return row.status;
    case 'contract':
      return row.symbol === null && row.strike === null
        ? null
        : `${row.symbol ?? ''} ${String(row.strike ?? 0).padStart(10, '0')}`;
    case 'entry':
      return timeOf(row.entryTime);
    case 'exit':
      return timeOf(row.exitTime);
    case 'quantity':
      return row.quantity;
    case 'straddle':
      return row.straddleAtEntry;
    case 'net':
      return row.netPnl;
    case 'pnlPct':
      return row.pnlPct;
    case 'reason':
      return row.exitReasonLabel || null;
    case 'regime':
      return row.regime;
    case 'vix':
      return row.vixAtEntry;
  }
}

/** Sorted copy; missing values go last in both directions and ties keep the input order. */
export function sortTradeRows(rows: readonly TradeRow[], sort: TradeSort): TradeRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: sortValue(row, sort.key) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === b.value) return a.index - b.index;
        return a.value === null ? 1 : -1;
      }
      const cmp =
        typeof a.value === 'string' || typeof b.value === 'string'
          ? String(a.value).localeCompare(String(b.value))
          : a.value - b.value;
      return cmp !== 0 ? cmp * sign : a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** After a header click: the same column flips; a new one starts A→Z for text, biggest first otherwise. */
export function nextTradeSort(current: TradeSort, key: TradeSortKey): TradeSort {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: TEXT_KEYS.has(key) ? 'asc' : 'desc' };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/** "2026-09-28 09:30:00" in IST, sortable and free of commas; "" when missing. */
export function csvIstDateTime(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${istToday(date)} ${formatIstTime(date, { seconds: true })}`;
}

/** Column key → header, in export order (the shape lib/csv.ts's downloadCsv takes). */
export const TRADE_CSV_COLUMNS: Array<[string, string]> = [
  ['id', 'Trade ID'],
  ['personality', 'Personality'],
  ['status', 'Status'],
  ['symbol', 'Symbol'],
  ['strike', 'Strike'],
  ['expiry', 'Expiry (IST)'],
  ['entry', 'Entry time (IST)'],
  ['exit', 'Exit time (IST)'],
  ['durationMin', 'Duration (min)'],
  ['lots', 'Lots'],
  ['lotSize', 'Lot size'],
  ['straddle', 'Straddle at entry (₹)'],
  ['gross', 'Gross P&L (₹)'],
  ['net', 'Net P&L (₹)'],
  ['pnlPct', 'P&L % of premium'],
  ['reason', 'Exit reason'],
  ['regime', 'Regime'],
  ['vix', 'VIX at entry'],
];

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Plain values for the CSV: raw numbers (no grouping or ₹), IST times, readable labels. */
export function tradeCsvRows(rows: readonly TradeRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    id: row.id,
    personality: row.personalityName,
    status: row.status === 'open' ? 'Open' : 'Closed',
    symbol: row.symbol ?? '',
    strike: row.strike ?? '',
    expiry: row.expiry === null ? '' : (tradeEntryDay({ entry_time: row.expiry }) ?? ''),
    entry: csvIstDateTime(row.entryTime),
    exit: csvIstDateTime(row.exitTime),
    durationMin: row.durationMs === null ? '' : round2(row.durationMs / 60_000),
    lots: row.lots ?? '',
    lotSize: row.lotSize ?? '',
    straddle: row.straddleAtEntry ?? '',
    gross: row.grossPnl ?? '',
    net: row.netPnl ?? '',
    pnlPct: row.pnlPct === null ? '' : round2(row.pnlPct * 100),
    reason: row.exitReasonLabel,
    regime: row.regime ?? '',
    vix: row.vixAtEntry ?? '',
  }));
}

/** "paper-trades-2026-10-05.csv". */
export function tradesCsvFilename(today: string = istToday()): string {
  return `paper-trades-${today}.csv`;
}
