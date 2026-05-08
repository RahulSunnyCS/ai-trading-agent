// Fyers instrument symbol builder for NSE/BSE index options.
//
// Fyers symbol format reference:
//   Equity:         NSE:SBIN-EQ
//   Index (spot):   NSE:NIFTY-INDEX    BSE:SENSEX-INDEX
//   VIX:            NSE:INDIAVIX-INDEX
//   Monthly option: NSE:NIFTY25MAY2524000CE
//   Weekly option:  NSE:NIFTY255824000CE
//                        ^^ ^^ ^^
//                        YY  M DD   (M is single digit for Jan-Sep, O/N/D for Oct-Dec)
//
// The weekly format uses: {YY}{M_single}{DD}
//   Jan=1, Feb=2, ..., Sep=9, Oct=O, Nov=N, Dec=D
//
// This string-based approach is why Fyers was chosen over Angel One:
//   - No scripmaster download required
//   - New weekly contracts (listed every Thursday) are addressed by constructing
//     the symbol string — no token lookup, no file parsing, no cron job

import type { Underlying, OptionType } from '../../db/schema';
import type { Instrument } from './types';

// ── Index spot and VIX symbols ─────────────────────────────────────────────────

export const FYERS_INDEX_SYMBOLS = {
  NIFTY:     'NSE:NIFTY-INDEX',
  BANKNIFTY: 'NSE:NIFTYBANK-INDEX',
  SENSEX:    'BSE:SENSEX-INDEX',
  VIX:       'NSE:INDIAVIX-INDEX',
} as const;

// Exchange prefix per underlying
const EXCHANGE: Record<Underlying, 'NSE' | 'BSE'> = {
  NIFTY:     'NSE',
  BANKNIFTY: 'NSE',
  SENSEX:    'BSE',
};

// ── Month code builder ─────────────────────────────────────────────────────────
// Fyers weekly option uses single character for month:
// Jan-Sep → '1'-'9', Oct → 'O', Nov → 'N', Dec → 'D'

function weeklyMonthCode(month: number): string {
  if (month < 10) return String(month);
  return ['O', 'N', 'D'][month - 10]!;
}

// 3-letter month abbreviation for monthly option symbols
const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// ── Symbol builders ────────────────────────────────────────────────────────────

/**
 * Build a Fyers weekly option symbol.
 * Example: NIFTY, May 8 2025, 24000 CE → "NSE:NIFTY255824000CE"
 */
export function buildWeeklySymbol(
  underlying: Underlying,
  expiry: Date,
  strike: number,
  optionType: OptionType
): string {
  const yy      = String(expiry.getFullYear()).slice(2);
  const m       = weeklyMonthCode(expiry.getMonth() + 1);
  const dd      = String(expiry.getDate()).padStart(2, '0');
  const exch    = EXCHANGE[underlying];
  return `${exch}:${underlying}${yy}${m}${dd}${strike}${optionType}`;
}

/**
 * Build a Fyers monthly option symbol.
 * Example: NIFTY, May 2025, 24000 CE → "NSE:NIFTY25MAY2524000CE"
 */
export function buildMonthlySymbol(
  underlying: Underlying,
  expiry: Date,
  strike: number,
  optionType: OptionType
): string {
  const yy      = String(expiry.getFullYear()).slice(2);
  const mon     = MONTH_ABBR[expiry.getMonth()];
  const year4   = expiry.getFullYear();
  const exch    = EXCHANGE[underlying];
  return `${exch}:${underlying}${yy}${mon}${year4}${strike}${optionType}`;
}

/**
 * Main entry point used by the broker adapter.
 * NSE weekly options (Nifty, BankNifty) expire on Thursday.
 * BSE Sensex weekly options expire on Friday.
 * The last Thursday of the month is the monthly expiry — use monthly format for that.
 */
export function buildFyersSymbol(instrument: Instrument): string {
  const { underlying, expiry, strike, optionType } = instrument;
  return isMonthlyExpiry(expiry)
    ? buildMonthlySymbol(underlying, expiry, strike, optionType)
    : buildWeeklySymbol(underlying, expiry, strike, optionType);
}

/**
 * Returns true if this expiry is the monthly (last Thursday of the month).
 * NSE monthly expiry = last Thursday of the month.
 */
export function isMonthlyExpiry(expiry: Date): boolean {
  const nextWeek = new Date(expiry);
  nextWeek.setDate(expiry.getDate() + 7);
  // If adding 7 days crosses into next month → this is the last Thursday
  return nextWeek.getMonth() !== expiry.getMonth();
}

// ── Expiry helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the next Thursday from a given date (or today if it's Thursday).
 * NSE weekly option expiry day.
 */
export function nextThursday(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setHours(15, 30, 0, 0);
  const day = d.getDay(); // 0=Sun, 4=Thu
  const daysAhead = day <= 4 ? 4 - day : 11 - day;
  d.setDate(d.getDate() + daysAhead);
  return d;
}

/**
 * Returns the next Friday from a given date.
 * BSE Sensex weekly option expiry day.
 */
export function nextFriday(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setHours(15, 30, 0, 0);
  const day = d.getDay();
  const daysAhead = day <= 5 ? 5 - day : 12 - day;
  d.setDate(d.getDate() + daysAhead);
  return d;
}

/**
 * Returns the current weekly expiry for a given underlying.
 */
export function currentExpiry(underlying: Underlying): Date {
  return underlying === 'SENSEX' ? nextFriday() : nextThursday();
}

// ── Reverse parser (for incoming tick routing) ─────────────────────────────────

interface ParsedSymbol {
  underlying: Underlying;
  expiry:     Date;
  strike:     number;
  optionType: OptionType;
}

const INDEX_SYMBOLS_REVERSE: Record<string, Underlying> = {
  'NSE:NIFTY-INDEX':    'NIFTY',
  'NSE:NIFTYBANK-INDEX':'BANKNIFTY',
  'BSE:SENSEX-INDEX':   'SENSEX',
};

/**
 * Parse a Fyers symbol string back into structured fields.
 * Returns null for index/VIX symbols (not option instruments).
 */
export function parseFyersSymbol(symbol: string): (ParsedSymbol & { isIndex: boolean; isVix: boolean }) | null {
  // Index symbols
  if (symbol in INDEX_SYMBOLS_REVERSE) {
    return null;
  }
  if (symbol === 'NSE:INDIAVIX-INDEX') {
    return null;
  }

  // Option symbols: NSE:NIFTY255824000CE or NSE:NIFTY25MAY2524000CE
  const weeklyRe  = /^(NSE|BSE):(NIFTY|NIFTYBANK|SENSEX)(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)$/;
  const monthlyRe = /^(NSE|BSE):(NIFTY|NIFTYBANK|SENSEX)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4})(\d+)(CE|PE)$/;

  let match = symbol.match(weeklyRe);
  if (match) {
    const [, , sym, yy, mCode, dd, strikeStr, opt] = match;
    const underlying = sym === 'NIFTYBANK' ? 'BANKNIFTY' : sym as Underlying;
    const monthIdx   = '123456789OND'.indexOf(mCode);
    const expiry     = new Date(2000 + Number(yy), monthIdx, Number(dd), 15, 30, 0, 0);
    return { underlying, expiry, strike: Number(strikeStr), optionType: opt as OptionType, isIndex: false, isVix: false };
  }

  match = symbol.match(monthlyRe);
  if (match) {
    const [, , sym, , mon, year, strikeStr, opt] = match;
    const underlying = sym === 'NIFTYBANK' ? 'BANKNIFTY' : sym as Underlying;
    const monthIdx   = MONTH_ABBR.indexOf(mon);
    const expiry     = new Date(Number(year), monthIdx, 1, 15, 30, 0, 0);
    // Find last Thursday of month
    expiry.setMonth(expiry.getMonth() + 1, 0); // last day of month
    while (expiry.getDay() !== 4) expiry.setDate(expiry.getDate() - 1);
    return { underlying, expiry, strike: Number(strikeStr), optionType: opt as OptionType, isIndex: false, isVix: false };
  }

  return null;
}
