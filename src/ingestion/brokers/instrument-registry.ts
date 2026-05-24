/**
 * Instrument Registry — ATM strike calculation, weekly expiry resolution,
 * and Fyers option symbol builder.
 *
 * All functions are pure (no external calls, no DB access) so they can be
 * unit-tested in isolation without any broker connection or database.
 *
 * Usage:
 *   const strike = getAtmStrike('NIFTY', 22437);           // 22450
 *   const expiry = getCurrentExpiry('NIFTY');              // nearest Thursday
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
 * Given a Date (interpreted as a UTC calendar date), return the nearest
 * Thursday that is on or after that date.
 *
 * NSE weekly index options expire on Thursdays. Same-day Thursday expiry
 * is valid until 15:30 IST, so a Thursday date is returned as-is here —
 * the 15:30 cut-off is handled one level up in getCurrentExpiry().
 *
 * The returned Date has its time components zeroed so callers get a pure
 * calendar date and can format it without worrying about hour noise.
 */
export function getNearestThursday(date: Date): Date {
  // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const day = date.getUTCDay();
  // (4 - day + 7) % 7 gives 0 if already Thursday, 1–6 otherwise
  const daysUntilThursday = (4 - day + 7) % 7;
  const result = new Date(date);
  result.setUTCDate(date.getUTCDate() + daysUntilThursday);
  // Zero the time component so this is a pure date value
  result.setUTCHours(0, 0, 0, 0);
  return result;
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
 * Format: NSE:{UNDERLYING}{expiry}{strike}{type}
 * where expiry is the compact Fyers encoding (see formatFyersExpiry).
 *
 * Examples:
 *   buildOptionSymbol('NIFTY',    Jan25Expiry, 24500, 'CE') → 'NSE:NIFTY2412524500CE'
 *   buildOptionSymbol('NIFTY',    Oct10Expiry, 24500, 'PE') → 'NSE:NIFTY24O1024500PE'
 *   buildOptionSymbol('BANKNIFTY', expiry,     47400, 'CE') → 'NSE:BANKNIFTY24...'
 */
export function buildOptionSymbol(
  underlying: Underlying,
  expiry: Date,
  strike: number,
  type: 'CE' | 'PE',
): string {
  const expiryStr = formatFyersExpiry(expiry);
  return `NSE:${underlying}${expiryStr}${strike}${type}`;
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
 * Rule:
 *   - If today is Thursday AND the IST wall clock is at or past 15:30,
 *     today's expiry has closed; advance to the following Thursday.
 *   - Otherwise, return the nearest Thursday on or after today.
 *
 * The clock parameter is injectable so this function is fully deterministic
 * in tests — pass a FixedClock at any IST instant to verify boundary conditions.
 *
 * IST is UTC+5:30 (no daylight saving) — the offset is applied manually via
 * arithmetic rather than relying on the host TZ setting, which can vary
 * across environments (Docker, CI, dev machine).
 *
 * @param underlying The index (NIFTY, BANKNIFTY, SENSEX) — reserved for
 *   future per-underlying expiry calendar differences; currently all three
 *   use Thursday expiry.
 * @param clock Injectable clock (default: RealClock for production)
 */
export function getCurrentExpiry(_underlying: Underlying, clock: Clock = new RealClock()): Date {
  // IST = UTC + 5h30m. India does not observe daylight saving, so this
  // offset is constant. We use arithmetic rather than Intl.DateTimeFormat
  // to avoid any locale / TZ configuration dependency.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowUtcMs = clock.timestamp();

  // Compute "now" in IST as a UTC Date object (all UTC getters will return IST values)
  const nowIst = new Date(nowUtcMs + IST_OFFSET_MS);

  const isThursday = nowIst.getUTCDay() === 4;
  // 15:30 IST is the cut-off after which same-day expiry is no longer valid
  const pastEOD =
    nowIst.getUTCHours() > 15 || (nowIst.getUTCHours() === 15 && nowIst.getUTCMinutes() >= 30);

  // When today's expiry window is closed, jump forward by exactly 7 days
  // so getNearestThursday lands on next week's Thursday.
  const referenceDate =
    isThursday && pastEOD ? new Date(nowUtcMs + IST_OFFSET_MS + 7 * 24 * 60 * 60 * 1000) : nowIst;

  return getNearestThursday(referenceDate);
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
