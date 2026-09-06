/**
 * Instrument Registry — ATM strike calculation, weekly expiry resolution,
 * and Fyers option symbol builder.
 *
 * All functions are pure (no external calls, no DB access) so they can be
 * unit-tested in isolation without any broker connection or database.
 *
 * Usage:
 *   const strike = getAtmStrike('NIFTY', 22437);           // 22450
 *   const expiry = getCurrentExpiry('NIFTY');              // NIFTY: nearest Tuesday
 *   const symbol = buildOptionSymbol('NIFTY', expiry, strike, 'CE');
 *
 * Per-underlying expiry rules (empirically verified against Fyers option-chain, 2026-05-27):
 *   NIFTY    — WEEKLY, expires every Tuesday
 *   BANKNIFTY — MONTHLY, expires on the last Tuesday of the month (no weeklies)
 *   SENSEX   — WEEKLY, expires every Thursday; exchange prefix is BSE: (not NSE:)
 */

import type { Clock } from '../../utils/clock';
import { RealClock } from '../../utils/clock';
import { MONTH_CODES, type MonthCode, type Underlying } from './types';

// Re-export Underlying so tests and downstream modules can import it from
// instrument-registry without needing to know the type lives in types.ts.
export type { Underlying };

// ---------------------------------------------------------------------------
// ATM strike intervals
// ---------------------------------------------------------------------------

/**
 * Minimum price increment between adjacent ATM strikes per underlying.
 * NIFTY uses 50-point intervals; BankNifty and Sensex use 100-point intervals.
 * Always call getAtmStrike() — never compute the rounding inline.
 */
export const STRIKE_INTERVALS: Record<Underlying, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  SENSEX: 100,
};

/**
 * NSE-standard strike intervals by underlying (alias for STRIKE_INTERVALS).
 * Both names are exported so existing code that imports ATM_STRIKE_INTERVALS
 * from the milestones-0-1 branch continues to compile.
 */
export const ATM_STRIKE_INTERVALS = STRIKE_INTERVALS;

// ---------------------------------------------------------------------------
// ATM strike rounding
// ---------------------------------------------------------------------------

/**
 * Round price to the nearest ATM strike for the given underlying.
 *
 * Uses standard "round half up" semantics via Math.round, which matches
 * how NSE publishes ATM strikes in their option chain.
 *
 * Always use this function — never compute rounding inline, because the
 * interval varies per underlying and inline code is easy to get wrong.
 *
 * Examples:
 *   getAtmStrike('NIFTY', 22437)    → 22450
 *   getAtmStrike('NIFTY', 22424)    → 22400
 *   getAtmStrike('BANKNIFTY', 47351) → 47400
 */
export function getAtmStrike(underlying: Underlying, price: number): number {
  const interval = STRIKE_INTERVALS[underlying];
  return Math.round(price / interval) * interval;
}

// ---------------------------------------------------------------------------
// Weekly expiry date helpers
// ---------------------------------------------------------------------------

/**
 * Given a Date (interpreted as a UTC calendar date), return the nearest date
 * with the given day-of-week (0=Sun … 6=Sat) that is on or after that date.
 *
 * Same-day is returned unchanged (days-until = 0 when already on target DOW).
 * Time components are zeroed so the result is a pure calendar date value.
 *
 * This is the generalised form of the old getNearestThursday helper.
 * Both the weekly-expiry logic and the backward-compat wrapper use it.
 */
export function getNearestWeekday(date: Date, targetDow: number): Date {
  // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const day = date.getUTCDay();
  // (targetDow - day + 7) % 7 gives 0 when already on the target, else 1–6
  const daysUntil = (targetDow - day + 7) % 7;
  const result = new Date(date);
  result.setUTCDate(date.getUTCDate() + daysUntil);
  // Zero the time component so this is a pure date value
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

/**
 * Backward-compatible wrapper: returns the nearest Thursday on or after `date`.
 *
 * NSE weekly SENSEX options expire on Thursdays.  This function is kept for
 * code that imported it directly before the per-underlying generalisation.
 * New code should prefer getNearestWeekday(date, 4) or getCurrentExpiry().
 */
export function getNearestThursday(date: Date): Date {
  return getNearestWeekday(date, 4); // 4 = Thursday
}

/**
 * Return the LAST occurrence of the given weekday (0=Sun … 6=Sat) within the
 * specified calendar month.
 *
 * Year and monthIndex0 are UTC (0-based month, so Jan=0, Dec=11).
 * The result has its time components zeroed (pure calendar date, UTC).
 *
 * Used for BANKNIFTY which expires on the last Tuesday of each month.
 */
export function getLastWeekdayOfMonth(
  year: number,
  monthIndex0: number,
  targetDow: number,
): Date {
  // Start from the last day of the month and walk backward until we hit the target DOW.
  // Using 0 as the day in Date constructor gives the last day of the previous month,
  // so monthIndex0 + 1 with day=0 gives the last day of monthIndex0.
  const lastDay = new Date(Date.UTC(year, monthIndex0 + 1, 0));
  // Compute days to subtract to land on targetDow
  const dow = lastDay.getUTCDay();
  const daysBack = (dow - targetDow + 7) % 7;
  lastDay.setUTCDate(lastDay.getUTCDate() - daysBack);
  lastDay.setUTCHours(0, 0, 0, 0);
  return lastDay;
}

// ---------------------------------------------------------------------------
// Fyers expiry string encoding
// ---------------------------------------------------------------------------

/**
 * Encode a Date as the Fyers expiry component: YY + MonthCode + DD (zero-padded).
 *
 * Fyers uses a compact encoding where Jan–Sep are '1'–'9' and Oct–Dec are
 * 'O', 'N', 'D'. This avoids ambiguity with two-digit month numbers in the
 * symbol string (which has no delimiter between components).
 *
 * Examples:
 *   Jan 25 2024 → '24125'   (yy='24', month='1', dd='25')
 *   Oct 10 2024 → '24O10'   (yy='24', month='O', dd='10')
 *   Dec  5 2024 → '24D05'   (yy='24', month='D', dd='05')
 *
 * The date is read in UTC because all internal Dates are already IST-offset
 * UTC (see getCurrentExpiry) so UTCDate is the correct calendar day.
 */
export function formatFyersExpiry(date: Date): string {
  const yy = String(date.getUTCFullYear()).slice(2);
  // getUTCMonth() is 0-indexed; MONTH_CODES is indexed the same way
  const month = date.getUTCMonth();
  const monthCode: MonthCode = MONTH_CODES[month] as MonthCode;
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}${monthCode}${dd}`;
}

// ---------------------------------------------------------------------------
// Exchange prefix mapping and Fyers index symbols
// ---------------------------------------------------------------------------

/**
 * Exchange prefix for each underlying's option contracts.
 *
 * NIFTY and BANKNIFTY are NSE-listed; SENSEX is BSE-listed.
 * This affects both the option symbol and the index data-feed symbol.
 *
 * Verified live against Fyers option-chain on 2026-05-27.
 */
export const EXCHANGE_PREFIX: Record<Underlying, 'NSE' | 'BSE'> = {
  NIFTY: 'NSE',
  BANKNIFTY: 'NSE',
  SENSEX: 'BSE',
};

/**
 * Authoritative Fyers index symbols for each underlying.
 *
 * Use these constants instead of inline string literals to ensure consistent
 * spelling across the codebase and to make exchange changes trivially discoverable.
 *
 * Verified live against Fyers data-feed on 2026-05-27:
 *   NIFTY     → NSE:NIFTY50-INDEX
 *   BANKNIFTY → NSE:NIFTYBANK-INDEX
 *   SENSEX    → BSE:SENSEX-INDEX
 */
export const INDEX_SYMBOLS: Record<Underlying, string> = {
  NIFTY: 'NSE:NIFTY50-INDEX',
  BANKNIFTY: 'NSE:NIFTYBANK-INDEX',
  SENSEX: 'BSE:SENSEX-INDEX',
};

// ---------------------------------------------------------------------------
// Full Fyers option symbol builder
// ---------------------------------------------------------------------------

/**
 * Build the full Fyers option symbol string for a given strike and expiry.
 *
 * Format: {EXCHANGE}:{UNDERLYING}{expiry}{strike}{type}
 * where EXCHANGE is NSE for NIFTY/BANKNIFTY and BSE for SENSEX,
 * and expiry is the compact Fyers encoding (see formatFyersExpiry).
 *
 * Examples:
 *   buildOptionSymbol('NIFTY',    Jan23Expiry, 24500, 'CE') → 'NSE:NIFTY2412324500CE'
 *   buildOptionSymbol('NIFTY',    Oct10Expiry, 24500, 'PE') → 'NSE:NIFTY24O1024500PE'
 *   buildOptionSymbol('BANKNIFTY', expiry,     47400, 'CE') → 'NSE:BANKNIFTY24...'
 *   buildOptionSymbol('SENSEX',   expiry,      81000, 'CE') → 'BSE:SENSEX24...'
 */
export function buildOptionSymbol(
  underlying: Underlying,
  expiry: Date,
  strike: number,
  type: 'CE' | 'PE',
): string {
  const expiryStr = formatFyersExpiry(expiry);
  // Exchange prefix is BSE for SENSEX, NSE for all others.
  // Hardcoding NSE for all three (as the old code did) caused Fyers to return
  // no data for SENSEX options — the correct prefix is required by the exchange.
  const exchange = EXCHANGE_PREFIX[underlying];
  return `${exchange}:${underlying}${expiryStr}${strike}${type}`;
}

/**
 * Alias for buildOptionSymbol — provided so callers from the milestones-0-1
 * branch that imported `buildFyersSymbol` continue to compile without changes.
 */
export function buildFyersSymbol(opts: {
  underlying: Underlying;
  expiry: Date;
  strike: number;
  optionType: 'CE' | 'PE';
}): string {
  return buildOptionSymbol(opts.underlying, opts.expiry, opts.strike, opts.optionType);
}

// ---------------------------------------------------------------------------
// Angel One Token Placeholder
// ---------------------------------------------------------------------------

/**
 * Build a placeholder Angel One instrument identifier.
 *
 * IMPORTANT LIMITATION:
 * Angel One uses numeric instrument tokens (not string symbols) for order
 * placement and WebSocket subscriptions. These tokens are assigned by Angel
 * One and change with each contract series — they are NOT derivable from the
 * option parameters alone. To resolve a real token, the caller must look up
 * the live instrument master file published by Angel One.
 *
 * This format is used only for logging, diagnostics, and tests — it must
 * NEVER be passed to the Angel One API.
 *
 * Placeholder format: AO:{UNDERLYING}:{STRIKE}:{OPTIONTYPE}:{YYYYMMDD}
 * Example: AO:NIFTY:23000:CE:20251016
 */
export function buildAngelOneToken(opts: {
  underlying: Underlying;
  expiry: Date;
  strike: number;
  optionType: 'CE' | 'PE';
}): string {
  const { underlying, expiry, strike, optionType } = opts;

  const yyyy = expiry.getFullYear();
  const mm = String(expiry.getMonth() + 1).padStart(2, '0');
  const dd = String(expiry.getDate()).padStart(2, '0');
  const strikeStr = String(Math.trunc(strike));

  return `AO:${underlying}:${strikeStr}:${optionType}:${yyyy}${mm}${dd}`;
}

// ---------------------------------------------------------------------------
// Current expiry resolver
// ---------------------------------------------------------------------------

/**
 * Returns the current expiry date for the given underlying,
 * taking the current IST time into account.
 *
 * Per-underlying rules (verified live against Fyers option-chain 2026-05-27):
 *   NIFTY    — nearest TUESDAY on or after today (weekly).
 *              If today is Tuesday at or past 15:30 IST, advance 7 days to next Tuesday.
 *   SENSEX   — nearest THURSDAY on or after today (weekly).
 *              If today is Thursday at or past 15:30 IST, advance 7 days to next Thursday.
 *   BANKNIFTY — last TUESDAY of the current calendar month (monthly, no weeklies).
 *              If today is that last Tuesday at or past 15:30 IST (expiry closed),
 *              advance to the last Tuesday of NEXT month.
 *
 * The clock parameter is injectable so this function is fully deterministic
 * in tests — pass a FixedClock at any IST instant to verify boundary conditions.
 *
 * IST is UTC+5:30 (no daylight saving) — the offset is applied manually via
 * arithmetic rather than relying on the host TZ setting, which can vary
 * across environments (Docker, CI, dev machine).
 *
 * @param underlying The index whose expiry calendar to use.
 * @param clock Injectable clock (default: RealClock for production)
 */
export function getCurrentExpiry(underlying: Underlying, clock: Clock = new RealClock()): Date {
  // IST = UTC + 5h30m. India does not observe daylight saving, so this
  // offset is constant. We use arithmetic rather than Intl.DateTimeFormat
  // to avoid any locale / TZ configuration dependency.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowUtcMs = clock.timestamp?.() ?? clock.now();

  // Compute "now" in IST as a UTC Date object (all UTC getters will return IST values)
  const nowIst = new Date(nowUtcMs + IST_OFFSET_MS);

  // 15:30 IST is the cut-off after which same-day expiry is no longer tradeable
  const pastEOD =
    nowIst.getUTCHours() > 15 || (nowIst.getUTCHours() === 15 && nowIst.getUTCMinutes() >= 30);

  if (underlying === 'NIFTY') {
    // NIFTY: weekly Tuesday expiry (DOW 2)
    const isTuesday = nowIst.getUTCDay() === 2;
    // If today is expiry day and market is closed, skip to next week's expiry
    const referenceDate =
      isTuesday && pastEOD
        ? new Date(nowUtcMs + IST_OFFSET_MS + 7 * 24 * 60 * 60 * 1000)
        : nowIst;
    return getNearestWeekday(referenceDate, 2); // 2 = Tuesday
  }

  if (underlying === 'SENSEX') {
    // SENSEX: weekly Thursday expiry (DOW 4), BSE-listed
    const isThursday = nowIst.getUTCDay() === 4;
    const referenceDate =
      isThursday && pastEOD
        ? new Date(nowUtcMs + IST_OFFSET_MS + 7 * 24 * 60 * 60 * 1000)
        : nowIst;
    return getNearestWeekday(referenceDate, 4); // 4 = Thursday
  }

  // BANKNIFTY: monthly — last Tuesday of the current calendar month.
  // If that date is in the past, or it is today and market is closed, roll to next month.
  const year = nowIst.getUTCFullYear();
  const month = nowIst.getUTCMonth(); // 0-indexed
  const lastTuesdayThisMonth = getLastWeekdayOfMonth(year, month, 2); // 2 = Tuesday

  // "Today" as a UTC midnight timestamp so we can compare calendar dates
  const todayMidnightIst = new Date(
    Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()),
  );
  const expiryMidnight = new Date(lastTuesdayThisMonth); // already midnight UTC

  // Roll to next month's last Tuesday when:
  //   a) this month's last Tuesday is already past (before today), OR
  //   b) today IS the last Tuesday but past 15:30 IST (expiry window closed)
  const expiryIsToday = expiryMidnight.getTime() === todayMidnightIst.getTime();
  const expiryIsPast = expiryMidnight.getTime() < todayMidnightIst.getTime();

  if (expiryIsPast || (expiryIsToday && pastEOD)) {
    // Roll to next month — month + 1 may overflow; Date handles it correctly
    return getLastWeekdayOfMonth(year, month + 1, 2);
  }

  return lastTuesdayThisMonth;
}

/**
 * Alias for getCurrentExpiry — provided for compatibility with callers from
 * the milestones-0-1 branch that imported getCurrentWeeklyExpiry.
 *
 * Note: the per-underlying expiry rules apply (NIFTY=Tuesday, BANKNIFTY=last
 * Tuesday of month, SENSEX=Thursday), even via this alias.
 */
export function getCurrentWeeklyExpiry(underlying: Underlying, referenceDate?: Date): Date {
  // When a referenceDate is supplied, build a minimal Clock shim that satisfies
  // the full Clock interface.  now() returns epoch ms (our Clock convention);
  // today/toISTDate/toISTTime are unused by getCurrentExpiry but must be present.
  const clock: Clock = referenceDate ? new FixedReferenceClock(referenceDate) : new RealClock();
  return getCurrentExpiry(underlying, clock);
}

/**
 * Alias for getCurrentExpiry — provided for forward compatibility with callers
 * that may have imported getCurrentExpiryForUnderlying.
 */
export const getCurrentExpiryForUnderlying = getCurrentExpiry;

/**
 * Minimal Clock implementation backed by a fixed Date, used only in
 * getCurrentWeeklyExpiry when a referenceDate is provided.
 * Not exported — internal implementation detail.
 */
class FixedReferenceClock implements Clock {
  private readonly _ms: number;
  constructor(date: Date) {
    this._ms = date.getTime();
  }
  now(): number {
    return this._ms;
  }
  timestamp(): number {
    return this._ms;
  }
  today(): string {
    // ISO date portion in IST — approximate via UTC+5:30 offset arithmetic
    const ist = new Date(this._ms + 5.5 * 60 * 60 * 1000);
    return ist.toISOString().slice(0, 10);
  }
  toISTDate(ms: number): string {
    const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
    return ist.toISOString().slice(0, 10);
  }
  toISTTime(ms: number): string {
    const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
    return ist.toISOString().slice(11, 19);
  }
}

// ---------------------------------------------------------------------------
// VIX Symbol
// ---------------------------------------------------------------------------

/**
 * Fyers symbol for India VIX.
 * Returns the constant string used to subscribe to VIX via Fyers WebSocket.
 */
export function getVixSymbol(): string {
  return 'NSE:INDIAVIX-INDEX';
}
