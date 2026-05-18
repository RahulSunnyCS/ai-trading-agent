/**
 * Instrument Registry
 *
 * Central source-of-truth for:
 *   - ATM strike rounding per underlying
 *   - Fyers symbol construction (weekly options)
 *   - Angel One token placeholder
 *   - Weekly expiry date calculation (Thursday for NIFTY/BANKNIFTY, Friday for SENSEX)
 *   - VIX symbol constant
 *
 * All exports are named exports (no default export) per project conventions.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type Underlying = "NIFTY" | "BANKNIFTY" | "SENSEX";

// ─── ATM Strike Intervals ────────────────────────────────────────────────────

/**
 * NSE-standard strike intervals by underlying.
 * NIFTY: 50pt, BankNifty: 100pt, Sensex: 100pt.
 * Using a const map rather than a switch so the compiler enforces exhaustiveness
 * if Underlying is ever extended.
 */
const ATM_STRIKE_INTERVALS: Record<Underlying, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  SENSEX: 100,
};

/**
 * Round a spot price to the nearest ATM strike for the given underlying.
 *
 * Uses standard "round half up" (Math.round), which is the convention
 * on NSE — a spot exactly halfway between two strikes rounds to the higher one.
 *
 * @example getAtmStrike('NIFTY', 23024) → 23000
 * @example getAtmStrike('NIFTY', 23025) → 23050  (half-up: 23025/50 = 460.5 → rounds to 461 → 23050)
 * @example getAtmStrike('BANKNIFTY', 49150) → 49200
 */
export function getAtmStrike(underlying: Underlying, spot: number): number {
  const interval = ATM_STRIKE_INTERVALS[underlying];
  return Math.round(spot / interval) * interval;
}

// ─── Fyers Symbol Builder ─────────────────────────────────────────────────────

/**
 * Fyers month encoding for weekly-option symbols.
 *
 * Fyers uses single-character month codes where Jan–Sep are digits '1'–'9'
 * and Oct/Nov/Dec are letters 'O', 'N', 'D' to keep the symbol compact and
 * unambiguous (no two-digit month number collides with a day number).
 *
 * This encoding is critical for October (index 9 → 'O') because without it
 * the symbol parser cannot distinguish month from day digits.
 */
const FYERS_MONTH_CODES: Record<number, string> = {
  0: "1", // January
  1: "2", // February
  2: "3", // March
  3: "4", // April
  4: "5", // May
  5: "6", // June
  6: "7", // July
  7: "8", // August
  8: "9", // September
  9: "O", // October  — letter, not digit
  10: "N", // November — letter, not digit
  11: "D", // December — letter, not digit
};

/**
 * Fyers exchange prefix by underlying.
 * SENSEX is BSE-listed; NIFTY and BANKNIFTY are NSE.
 */
const FYERS_EXCHANGE_PREFIX: Record<Underlying, string> = {
  NIFTY: "NSE",
  BANKNIFTY: "NSE",
  SENSEX: "BSE",
};

/**
 * Fyers underlying name as it appears in the symbol string.
 * BankNifty contracts use 'BANKNIFTY' without space.
 */
const FYERS_SYMBOL_NAME: Record<Underlying, string> = {
  NIFTY: "NIFTY",
  BANKNIFTY: "BANKNIFTY",
  SENSEX: "SENSEX",
};

/**
 * Build a Fyers weekly option symbol.
 *
 * Format: {EXCHANGE}:{UNDERLYING}{YY}{M}{DD}{STRIKE}{TYPE}
 *
 * Where:
 *   YY  = 2-digit year (2025 → '25')
 *   M   = single-char month code (see FYERS_MONTH_CODES)
 *   DD  = zero-padded 2-digit day (5 → '05')
 *   STRIKE = integer with no decimal point (23000 not 23000.0)
 *   TYPE   = 'CE' or 'PE'
 *
 * @example
 *   buildFyersSymbol({ underlying: 'NIFTY', expiry: new Date('2025-10-16'), strike: 23000, optionType: 'CE' })
 *   → 'NSE:NIFTY25O1623000CE'
 *
 * Notes:
 * - `expiry` is treated as a wall-clock date in the local (IST) timezone of
 *   the running process. The caller must ensure the Date object represents the
 *   correct expiry calendar date in IST.
 * - Strike is converted with Math.trunc to strip any floating-point residue
 *   before stringification, ensuring no decimal point appears in the symbol.
 */
export function buildFyersSymbol(opts: {
  underlying: Underlying;
  expiry: Date;
  strike: number;
  optionType: "CE" | "PE";
}): string {
  const { underlying, expiry, strike, optionType } = opts;

  const yy = String(expiry.getFullYear()).slice(-2); // '25' from 2025
  const monthCode = FYERS_MONTH_CODES[expiry.getMonth()]; // '1'..'9' | 'O'|'N'|'D'
  const dd = String(expiry.getDate()).padStart(2, "0"); // zero-pad day
  const strikeStr = String(Math.trunc(strike)); // no decimal point

  const exchange = FYERS_EXCHANGE_PREFIX[underlying];
  const symbolName = FYERS_SYMBOL_NAME[underlying];

  return `${exchange}:${symbolName}${yy}${monthCode}${dd}${strikeStr}${optionType}`;
}

// ─── Angel One Token Placeholder ─────────────────────────────────────────────

/**
 * Build a placeholder Angel One instrument identifier.
 *
 * IMPORTANT LIMITATION:
 * Angel One uses numeric instrument tokens (not string symbols) for order
 * placement and WebSocket subscriptions. These tokens are assigned by Angel
 * One and change with each contract series — they are NOT derivable from the
 * option parameters alone. To resolve a real token, the caller must look up
 * the live instrument master file published by Angel One (available via their
 * Market Data API as a daily CSV/JSON download).
 *
 * At Milestone 1, Angel One integration is not yet live, so we return a
 * deterministic human-readable placeholder that encodes all the relevant
 * dimensions. This format is used only for logging, diagnostics, and tests —
 * it must NEVER be passed to the Angel One API.
 *
 * Placeholder format: AO:{UNDERLYING}:{STRIKE}:{OPTIONTYPE}:{YYYYMMDD}
 * Example: AO:NIFTY:23000:CE:20251016
 *
 * When live Angel One integration is implemented, replace this function body
 * with a lookup against the downloaded instrument master (keyed by underlying,
 * expiry, strike, and optionType) and cache the result in Redis to avoid
 * repeated file I/O during market hours.
 */
export function buildAngelOneToken(opts: {
  underlying: Underlying;
  expiry: Date;
  strike: number;
  optionType: "CE" | "PE";
}): string {
  const { underlying, expiry, strike, optionType } = opts;

  const yyyy = expiry.getFullYear();
  // Pad month and day to 2 digits so the date segment is always 8 characters
  const mm = String(expiry.getMonth() + 1).padStart(2, "0");
  const dd = String(expiry.getDate()).padStart(2, "0");
  const strikeStr = String(Math.trunc(strike));

  return `AO:${underlying}:${strikeStr}:${optionType}:${yyyy}${mm}${dd}`;
}

// ─── Weekly Expiry Calculator ─────────────────────────────────────────────────

/**
 * Target expiry weekdays per underlying.
 * JS getDay(): 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.
 *
 * NIFTY and BANKNIFTY expire on Thursday (4).
 * SENSEX expires on Friday (5) — BSE weekly contract expiry.
 */
const EXPIRY_WEEKDAY: Record<Underlying, number> = {
  NIFTY: 4, // Thursday
  BANKNIFTY: 4, // Thursday
  SENSEX: 5, // Friday
};

/**
 * Return the nearest upcoming weekly expiry date for the given underlying.
 *
 * Rules:
 * - If `referenceDate` falls ON the expiry weekday, that date is returned
 *   (the current-day-is-expiry case is included, not skipped).
 * - Otherwise, advance forward until the next matching weekday.
 *
 * The returned Date's time components are set to midnight (00:00:00.000) on
 * the expiry day. The caller should not rely on the time portion.
 *
 * @param underlying - Which index to compute expiry for
 * @param referenceDate - Defaults to today (new Date()) if omitted
 *
 * @example
 *   // If today is Wednesday 2025-10-15, NIFTY expires Thursday 2025-10-16
 *   getCurrentWeeklyExpiry('NIFTY') → Date(2025-10-16)
 *
 *   // If today IS Thursday 2025-10-16, NIFTY expiry is the same day
 *   getCurrentWeeklyExpiry('NIFTY', new Date('2025-10-16')) → Date(2025-10-16)
 */
export function getCurrentWeeklyExpiry(underlying: Underlying, referenceDate?: Date): Date {
  const targetWeekday = EXPIRY_WEEKDAY[underlying];

  // Clone to avoid mutating the caller's Date object.
  // Strip time components so arithmetic is purely day-based.
  const ref = referenceDate ? new Date(referenceDate) : new Date();
  ref.setHours(0, 0, 0, 0);

  const currentWeekday = ref.getDay();

  // Calculate how many days ahead the target weekday is.
  // If daysAhead === 0, today IS expiry day — return today per spec.
  const daysAhead = (targetWeekday - currentWeekday + 7) % 7;

  const expiry = new Date(ref);
  expiry.setDate(ref.getDate() + daysAhead);

  return expiry;
}

// ─── VIX Symbol ──────────────────────────────────────────────────────────────

/**
 * Fyers symbol for India VIX.
 * Returns the constant string used to subscribe to VIX via Fyers WebSocket.
 * Extracted as a function (rather than a bare constant) so callers always
 * import from a single registry rather than hardcoding the symbol string.
 */
export function getVixSymbol(): string {
  return "NSE:INDIAVIX-INDEX";
}
