/**
 * Instrument Registry — ATM strike calculation, weekly expiry resolution,
 * and Fyers option symbol builder.
 *
 * Most functions are pure (no external calls, no DB access) so they can be
 * unit-tested in isolation without any broker connection or database.
 *
 * Multi-index additions (T-45):
 *   - buildOptionSymbol now uses a per-underlying exchange prefix:
 *       BSE: for SENSEX options, NSE: for NIFTY and BANKNIFTY options.
 *   - getCurrentExpiryFromCalendar reads expiry dates from the
 *       index_expiry_calendar DB table (migration 013) instead of the
 *       Thursday weekday formula. The original getCurrentExpiry (Thursday
 *       formula) is kept as a backward-compat fallback used by straddle-calc.ts
 *       on the hot 15-second snapshot path (cannot be made async there).
 *   - assertCalendarFreshness validates the calendar for an active underlying
 *       at startup: throws if no future expiry exists, warns if max seeded
 *       expiry is within CALENDAR_REFILL_DAYS.
 *
 * Usage:
 *   const strike = getAtmStrike('NIFTY', 22437);           // 22450
 *   const expiry = getCurrentExpiry('NIFTY');              // nearest Thursday (fallback)
 *   const expiryDb = await getCurrentExpiryFromCalendar('BANKNIFTY', db, clock); // calendar-driven
 *   const symbol = buildOptionSymbol('NIFTY', expiry, strike, 'CE');   // NSE:NIFTY...
 *   const sensexSymbol = buildOptionSymbol('SENSEX', expiry, strike, 'CE'); // BSE:SENSEX...
 */

import type { Pool } from 'pg';
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
// Exchange prefix map — T-45: per-underlying prefix
// ---------------------------------------------------------------------------

/**
 * The exchange prefix used in Fyers/broker option symbol strings for each
 * underlying. NIFTY and BANKNIFTY are NSE instruments; SENSEX is a BSE
 * instrument and must use the BSE: prefix in both WebSocket subscriptions
 * and option symbol strings.
 *
 * Source: Fyers instrument master files and exchange circulars. Verified
 * against QA checklist item "Sensex symbol uses BSE: prefix".
 *
 * IMPORTANT: if NSE or BSE changes the prefix convention for any index,
 * update this map and re-verify instrument master lookups.
 */
export const EXCHANGE_PREFIXES: Record<Underlying, string> = {
  NIFTY: 'NSE',
  BANKNIFTY: 'NSE',
  // Sensex weekly options are listed on BSE; Fyers uses BSE: prefix for these.
  SENSEX: 'BSE',
};

// ---------------------------------------------------------------------------
// Full Fyers option symbol builder
// ---------------------------------------------------------------------------

/**
 * Build the full Fyers option symbol string for a given strike and expiry.
 *
 * Format: {EXCHANGE}:{UNDERLYING}{expiry}{strike}{type}
 * where:
 *   - EXCHANGE is NSE for NIFTY/BANKNIFTY, BSE for SENSEX (T-45 change)
 *   - expiry is the compact Fyers encoding (see formatFyersExpiry)
 *
 * Examples:
 *   buildOptionSymbol('NIFTY',    Jan25Expiry, 24500, 'CE') → 'NSE:NIFTY2412524500CE'
 *   buildOptionSymbol('NIFTY',    Oct10Expiry, 24500, 'PE') → 'NSE:NIFTY24O1024500PE'
 *   buildOptionSymbol('BANKNIFTY', expiry,     47400, 'CE') → 'NSE:BANKNIFTY24...'
 *   buildOptionSymbol('SENSEX',    expiry,     80000, 'CE') → 'BSE:SENSEX24...'
 */
export function buildOptionSymbol(
  underlying: Underlying,
  expiry: Date,
  strike: number,
  type: 'CE' | 'PE',
): string {
  const expiryStr = formatFyersExpiry(expiry);
  // T-45: use per-underlying exchange prefix instead of hardcoded 'NSE'
  const prefix = EXCHANGE_PREFIXES[underlying];
  return `${prefix}:${underlying}${expiryStr}${strike}${type}`;
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
  const nowUtcMs = clock.timestamp?.() ?? clock.now();

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

// ---------------------------------------------------------------------------
// Calendar-driven expiry resolver (T-45) — reads index_expiry_calendar table
// ---------------------------------------------------------------------------

/**
 * How many days before the max seeded expiry date we emit a refill-reminder
 * log. The operator should add more rows to index_expiry_calendar before
 * the calendar runs dry. Configurable via CALENDAR_REFILL_DAYS env var;
 * defaults to 14 days.
 *
 * Kept separate from the hard-fail threshold (no future expiry = throw) —
 * the refill reminder is advisory; the hard-fail is mandatory.
 */
const DEFAULT_CALENDAR_REFILL_DAYS = 14;

/**
 * Read the nearest future expiry date for an underlying from the
 * index_expiry_calendar table (migration 013).
 *
 * Rules:
 *   - Returns the row with the smallest expiry_date that is >= today in IST.
 *   - If is_holiday_shifted is TRUE, the date is already the adjusted date
 *     (holiday logic was applied when the row was inserted); we use it as-is.
 *   - The IST date is computed from the clock so tests can inject a FixedClock.
 *
 * The function is async because it queries PostgreSQL. It is called at startup
 * (not on the hot 15-second snapshot path) so the latency is acceptable.
 *
 * @throws {CalendarExpiredError} if there is no future expiry in the calendar
 *   for the given underlying. This is a hard-fail — the process MUST NOT trade
 *   if the calendar is empty or stale.
 */
export async function getCurrentExpiryFromCalendar(
  underlying: Underlying,
  db: Pool,
  clock: Clock,
): Promise<Date> {
  // Use the clock to get today's IST date string so tests are deterministic.
  const todayIST = clock.today(); // 'YYYY-MM-DD'

  const result = await db.query<{ expiry_date: string; is_holiday_shifted: boolean }>(
    `SELECT expiry_date::text, is_holiday_shifted
     FROM index_expiry_calendar
     WHERE underlying = $1
       AND expiry_date >= $2::date
     ORDER BY expiry_date ASC
     LIMIT 1`,
    [underlying, todayIST],
  );

  if (result.rows.length === 0) {
    // No future expiry found — hard fail. The operator must populate the table.
    throw new CalendarExpiredError(underlying, todayIST);
  }

  const row = result.rows[0]!;
  // expiry_date comes back as 'YYYY-MM-DD' from the ::text cast.
  // Parse as UTC midnight so getUTCDate/Month/Year accessors work correctly
  // in formatFyersExpiry (which uses UTC getters on the assumption that all
  // dates are IST-day-aligned UTC values).
  const expiryDate = new Date(`${row.expiry_date}T00:00:00.000Z`);
  return expiryDate;
}

/**
 * Error thrown by getCurrentExpiryFromCalendar when the index_expiry_calendar
 * table has no future rows for the given underlying.
 *
 * This is a HARD FAIL — the calling code in index.ts must either disable the
 * underlying for the session (if non-critical) or abort startup (if NIFTY).
 */
export class CalendarExpiredError extends Error {
  constructor(
    public readonly underlying: Underlying,
    public readonly todayIST: string,
  ) {
    super(
      `[instrument-registry] HARD FAIL: index_expiry_calendar has no future expiry for ` +
        `${underlying} on or after ${todayIST}. ` +
        `Populate the table and restart. See src/db/migrations/013_index_expiry_calendar.sql.`,
    );
    this.name = 'CalendarExpiredError';
  }
}

/**
 * Assert that the index_expiry_calendar is fresh enough for an underlying:
 *
 *   1. HARD FAIL (throws CalendarExpiredError) if there is no future expiry
 *      on or after today in IST. Independent of the refill check.
 *
 *   2. REFILL REMINDER (console.warn only) if the maximum seeded expiry
 *      for the underlying is within CALENDAR_REFILL_DAYS days of today.
 *      This is a separate, independent check — even if a future expiry exists,
 *      the operator should add more rows soon.
 *
 * These two checks are intentionally separated so a partial calendar (e.g.
 * 1 future expiry left) triggers the refill reminder without blocking trades.
 *
 * @param underlying  The index to check.
 * @param db          PostgreSQL pool.
 * @param clock       Injected clock for deterministic testing.
 * @param refillDays  Override for CALENDAR_REFILL_DAYS (default: env var or 14).
 * @throws {CalendarExpiredError} if no future expiry exists.
 */
export async function assertCalendarFreshness(
  underlying: Underlying,
  db: Pool,
  clock: Clock,
  refillDays?: number,
): Promise<void> {
  const todayIST = clock.today(); // 'YYYY-MM-DD'

  // Parse the refill threshold: env var wins, then explicit param, then default.
  const envRefill = Number(process.env.CALENDAR_REFILL_DAYS ?? '');
  const effectiveRefillDays =
    Number.isFinite(envRefill) && envRefill > 0
      ? envRefill
      : (refillDays ?? DEFAULT_CALENDAR_REFILL_DAYS);

  // -------------------------------------------------------------------------
  // Check 1 (HARD FAIL): does any future expiry exist?
  //
  // We do this first. If the calendar is empty we throw immediately and do not
  // bother running the max-date check (which would return null and fail anyway).
  // -------------------------------------------------------------------------
  const futureRow = await db.query<{ expiry_date: string }>(
    `SELECT expiry_date::text
     FROM index_expiry_calendar
     WHERE underlying = $1
       AND expiry_date >= $2::date
     ORDER BY expiry_date ASC
     LIMIT 1`,
    [underlying, todayIST],
  );

  if (futureRow.rows.length === 0) {
    // Hard fail — no future expiry in the calendar at all.
    throw new CalendarExpiredError(underlying, todayIST);
  }

  // -------------------------------------------------------------------------
  // Check 2 (REFILL REMINDER): is the max seeded expiry date within N days?
  //
  // This is INDEPENDENT of check 1 — even when a future expiry exists, warn
  // the operator if the calendar will run out soon. Runs every startup so the
  // reminder fires before the calendar actually empties.
  // -------------------------------------------------------------------------
  const maxRow = await db.query<{ max_expiry: string | null }>(
    `SELECT MAX(expiry_date)::text AS max_expiry
     FROM index_expiry_calendar
     WHERE underlying = $1`,
    [underlying],
  );

  const maxExpiryStr = maxRow.rows[0]?.max_expiry;
  if (maxExpiryStr !== null && maxExpiryStr !== undefined) {
    const maxExpiryMs = new Date(`${maxExpiryStr}T00:00:00.000Z`).getTime();
    const todayMs = new Date(`${todayIST}T00:00:00.000Z`).getTime();
    const daysRemaining = (maxExpiryMs - todayMs) / (24 * 60 * 60 * 1000);

    if (daysRemaining <= effectiveRefillDays) {
      // Advisory warning only — does not block trading.
      console.warn(
        `[instrument-registry] CALENDAR REFILL REMINDER: ${underlying} calendar expires ` +
          `in ${Math.ceil(daysRemaining)} day(s) (max seeded expiry: ${maxExpiryStr}, ` +
          `threshold: ${effectiveRefillDays} days). ` +
          `Add more rows to index_expiry_calendar before it runs dry.`,
      );
    }
  }
  // If max_expiry is null the table is empty for this underlying — check 1
  // already threw in that case, so we never reach here with null max_expiry.
}

// ---------------------------------------------------------------------------
// Sim fixture for symbol resolution (T-45)
// ---------------------------------------------------------------------------

/**
 * Validates whether a computed ATM straddle symbol is "tradable" in simulation
 * mode. In LIVE mode, validation is done against the freshly-fetched broker
 * instrument master (see index.ts). In SIM mode there is no real instrument
 * master, so we use a static fixture that covers any valid symbol for the three
 * supported underlyings.
 *
 * Validation logic: a symbol is valid in SIM mode if:
 *   1. It starts with the correct exchange prefix for the underlying.
 *   2. The underlying name appears immediately after the prefix.
 *   3. It ends with 'CE' or 'PE'.
 *   4. There is a numeric component between the underlying name and the suffix
 *      (expiry + strike — we do not validate the exact expiry date in SIM mode
 *      because a perfect expiry date requires real calendar data).
 *
 * This is intentionally lenient: SIM mode is for development and integration
 * testing where exact expiry correctness is secondary to pipeline connectivity.
 * LIVE mode must validate against the real broker instrument master.
 *
 * Returns true if the symbol matches the expected pattern, false otherwise.
 */
export function validateSimSymbol(underlying: Underlying, symbol: string): boolean {
  const prefix = EXCHANGE_PREFIXES[underlying];
  // Expected pattern: {PREFIX}:{UNDERLYING}{digits+alpha(expiry)}{digits(strike)}{CE|PE}
  // Example: NSE:NIFTY26528024500CE or BSE:SENSEX26529080000CE
  // We use a regex that checks the structural shape rather than exact dates.
  const pattern = new RegExp(`^${prefix}:${underlying}\\d{2}[\\dOND]\\d{2}\\d+(CE|PE)$`);
  return pattern.test(symbol);
}
