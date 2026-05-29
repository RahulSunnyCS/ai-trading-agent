/**
 * Instrument Registry — ATM strike calculation, weekly expiry resolution,
 * and Fyers option symbol builder.
 *
 * All functions are pure (no external calls, no DB access) so they can be
 * unit-tested in isolation without any broker connection or database.
 *
 * Usage:
 *   const strike = getAtmStrike('NIFTY', 22437);           // 22450
 *   const expiry = getCurrentExpiry('NIFTY');              // nearest Tuesday (NSE)
 *   const symbol = buildOptionSymbol('NIFTY', expiry, strike, 'CE');
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
// Weekly expiry weekday per underlying
// ---------------------------------------------------------------------------

/**
 * Day-of-week (0=Sun … 6=Sat, UTC/IST) that each index's WEEKLY options expire.
 *
 * These are NOT all Thursday — NSE and BSE diverged:
 *   - NIFTY  (NSE): Tuesday  (verified against the live Fyers symbol master —
 *     listed weekly expiries 2026-06-02/09/16/23 are all Tuesdays).
 *   - SENSEX (BSE): Thursday (master: 2026-06-04/11/18 are all Thursdays).
 *   - BANKNIFTY: weekly options were discontinued by NSE; it now trades monthly
 *     only. Kept here for completeness (not in active backfill scope) — treated
 *     as Tuesday to match the current NSE index-options expiry day.
 *
 * Source of truth for the CURRENT rule is the Fyers symbol master
 * (src/ingestion/brokers/symbol-master.ts); these constants are the pure,
 * network-free fallback the registry uses for deterministic symbol math
 * (live + historical derivation).
 */
export const WEEKLY_EXPIRY_DOW: Record<Underlying, number> = {
  NIFTY: 2, // Tuesday
  BANKNIFTY: 2, // weekly discontinued; placeholder
  SENSEX: 4, // Thursday
};

/**
 * Exchange prefix per underlying. NIFTY/BankNifty are NSE; Sensex is a BSE
 * index, so its option symbols are 'BSE:SENSEX…' (verified against the BSE
 * symbol master — 'NSE:SENSEX…' is not a valid contract).
 */
export const EXCHANGE_BY_UNDERLYING: Record<Underlying, 'NSE' | 'BSE'> = {
  NIFTY: 'NSE',
  BANKNIFTY: 'NSE',
  SENSEX: 'BSE',
};

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
 * Given a Date (interpreted as a UTC calendar date) and a target weekday
 * (0=Sun … 6=Sat), return the nearest occurrence of that weekday on or after
 * the date.
 *
 * Same-day expiry is valid until 15:30 IST, so a date already on the target
 * weekday is returned as-is — the 15:30 cut-off is handled one level up in
 * getCurrentExpiry().
 *
 * The returned Date has its time components zeroed so callers get a pure
 * calendar date and can format it without worrying about hour noise.
 */
export function getNearestWeekday(date: Date, targetDow: number): Date {
  const day = date.getUTCDay();
  // (target - day + 7) % 7 gives 0 if already on target, 1–6 otherwise
  const daysUntil = (targetDow - day + 7) % 7;
  const result = new Date(date);
  result.setUTCDate(date.getUTCDate() + daysUntil);
  // Zero the time component so this is a pure date value
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

/**
 * @deprecated NIFTY weekly expiry moved to Tuesday; this Thursday-only helper
 * is retained for backward compatibility. Prefer getNearestWeekday(date, dow)
 * with the per-underlying WEEKLY_EXPIRY_DOW.
 */
export function getNearestThursday(date: Date): Date {
  return getNearestWeekday(date, 4);
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
// Full Fyers option symbol builder
// ---------------------------------------------------------------------------

/**
 * Build the full Fyers option symbol string for a given strike and expiry.
 *
 * Format: {EXCHANGE}:{UNDERLYING}{expiry}{strike}{type}
 * where expiry is the compact Fyers encoding (see formatFyersExpiry) and the
 * exchange is NSE for NIFTY/BankNifty, BSE for Sensex (see EXCHANGE_BY_UNDERLYING).
 *
 * Examples:
 *   buildOptionSymbol('NIFTY',  Jun02Expiry, 23550, 'CE') → 'NSE:NIFTY2660223550CE'
 *   buildOptionSymbol('NIFTY',  Oct10Expiry, 24500, 'PE') → 'NSE:NIFTY24O1024500PE'
 *   buildOptionSymbol('SENSEX', Jun04Expiry, 81000, 'CE') → 'BSE:SENSEX2660481000CE'
 */
export function buildOptionSymbol(
  underlying: Underlying,
  expiry: Date,
  strike: number,
  type: 'CE' | 'PE',
): string {
  const expiryStr = formatFyersExpiry(expiry);
  return `${EXCHANGE_BY_UNDERLYING[underlying]}:${underlying}${expiryStr}${strike}${type}`;
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
 * Returns the nearest weekly expiry date for the given underlying,
 * taking the current IST time into account.
 *
 * Rule (using the underlying's expiry weekday — Tuesday for NIFTY, Thursday
 * for Sensex — see WEEKLY_EXPIRY_DOW):
 *   - If today IS the expiry weekday AND the IST wall clock is at or past
 *     15:30, today's expiry has closed; advance to the following week.
 *   - Otherwise, return the nearest expiry weekday on or after today.
 *
 * NOTE: this does NOT yet apply NSE/BSE holiday shifts (if the expiry weekday
 * is a trading holiday the exchange moves expiry to the prior session). The
 * symbol master is authoritative for current contracts; holiday-shifted
 * historical weeks surface as detectable gaps rather than silent errors.
 *
 * The clock parameter is injectable so this function is fully deterministic
 * in tests — pass a FixedClock at any IST instant to verify boundary conditions.
 *
 * IST is UTC+5:30 (no daylight saving) — the offset is applied manually via
 * arithmetic rather than relying on the host TZ setting, which can vary
 * across environments (Docker, CI, dev machine).
 *
 * @param underlying The index (NIFTY, BANKNIFTY, SENSEX) — selects the expiry
 *   weekday via WEEKLY_EXPIRY_DOW.
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

  const expiryDow = WEEKLY_EXPIRY_DOW[underlying];
  const isExpiryDay = nowIst.getUTCDay() === expiryDow;
  // 15:30 IST is the cut-off after which same-day expiry is no longer valid
  const pastEOD =
    nowIst.getUTCHours() > 15 || (nowIst.getUTCHours() === 15 && nowIst.getUTCMinutes() >= 30);

  // When today's expiry window is closed, jump forward by exactly 7 days
  // so getNearestWeekday lands on next week's expiry.
  const referenceDate =
    isExpiryDay && pastEOD ? new Date(nowUtcMs + IST_OFFSET_MS + 7 * 24 * 60 * 60 * 1000) : nowIst;

  return getNearestWeekday(referenceDate, expiryDow);
}

/**
 * Alias for getCurrentExpiry — provided for compatibility with callers from
 * the milestones-0-1 branch that imported getCurrentWeeklyExpiry.
 */
export function getCurrentWeeklyExpiry(underlying: Underlying, referenceDate?: Date): Date {
  // When a referenceDate is supplied, build a minimal Clock shim that satisfies
  // the full Clock interface.  now() returns epoch ms (our Clock convention);
  // today/toISTDate/toISTTime are unused by getCurrentExpiry but must be present.
  const clock: Clock = referenceDate ? new FixedReferenceClock(referenceDate) : new RealClock();
  return getCurrentExpiry(underlying, clock);
}

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
