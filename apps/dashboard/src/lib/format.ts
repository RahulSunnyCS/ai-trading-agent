/**
 * Formatting utilities for the trading dashboard.
 *
 * All IST date/time helpers are built on `Intl.DateTimeFormat` with
 * `timeZone: 'Asia/Kolkata'` so results are stable regardless of the host
 * machine's local timezone — critical for CI servers that run in UTC and
 * developers on machines set to other timezones.
 */

// ---------------------------------------------------------------------------
// Numeric coercion
// ---------------------------------------------------------------------------

/**
 * Coerce a raw database value to a number, or null if the value is absent or
 * unparseable.
 *
 * The PostgreSQL `pg` driver sends NUMERIC/DECIMAL columns as strings (e.g.
 * "1234.50").  This helper centralises the parse so components never do ad-hoc
 * parseFloat() calls that silently return NaN.
 *
 * Rules:
 *  - null / undefined / empty string → null (value is absent)
 *  - NaN after parseFloat            → null (value is malformed)
 *  - Otherwise                       → the parsed number
 */
export function toNumberOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  if (Number.isNaN(n)) return null;
  return n;
}

// ---------------------------------------------------------------------------
// P&L / currency formatting
// ---------------------------------------------------------------------------

/**
 * Format a P&L value as a signed Indian-locale currency string with 2 decimal
 * places, e.g. "+1,234.50", "-50.00", "0.00".
 *
 * Sign convention:
 *  - Positive values get an explicit "+" prefix (e.g. "+100.00").
 *  - Negative values get the standard "-" from Intl (e.g. "-50.00").
 *  - Zero is shown as "0.00" with no sign prefix — "+" on zero is misleading.
 *
 * Comma grouping follows en-IN conventions (1,00,000.00 for lakhs).
 *
 * @param value  The numeric P&L amount.  Pass 0 for a flat result.
 * @returns      A human-readable string ready for display.
 */
export function formatPnl(value: number): string {
  // Intl.NumberFormat handles thousands-grouping and decimal rounding.
  // We use 'en-IN' locale so numbers format as per Indian convention
  // (lakh/crore grouping: 1,00,000) which is appropriate for this tool.
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));

  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted; // exactly 0.00
}

// ---------------------------------------------------------------------------
// IST date-time formatting
// ---------------------------------------------------------------------------

/**
 * Cached Intl.DateTimeFormat instances.
 * Constructing Intl.DateTimeFormat is relatively expensive; we create one
 * instance per formatter shape and reuse it across calls.
 */
const _dtParts = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const _dateParts = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Extract named Intl parts from a DateTimeFormat instance.
 * Returns an object keyed by `Intl.DateTimeFormatPartTypes`.
 */
function extractParts(formatter: Intl.DateTimeFormat, date: Date): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      result[part.type] = part.value;
    }
  }
  return result;
}

/**
 * Format an ISO-8601 UTC timestamp as a human-readable IST date-time string.
 *
 * Output format: "DD/MM/YYYY, HH:mm:ss" in IST, produced by Intl — the exact
 * visual format may vary slightly by runtime, but the timezone correctness is
 * guaranteed by the `timeZone: 'Asia/Kolkata'` option.
 *
 * Stable across timezones: the result is always IST regardless of the host
 * machine's local timezone setting.
 *
 * @param iso  ISO-8601 string (e.g. "2026-05-28T09:15:00.000Z").
 */
export function formatIstDateTime(iso: string): string {
  // We use the native Intl formatter directly here rather than constructing a
  // manual string from parts, because:
  //  1. It handles DST edge cases (IST is always UTC+5:30, no DST, but the
  //     Intl path is robust against future changes).
  //  2. The output is locale-correct for the target audience (en-IN).
  return _dtParts.format(new Date(iso));
}

/**
 * Return the current IST calendar date as a "YYYY-MM-DD" string.
 *
 * This is used as the "trading day" identifier — day boundaries happen at
 * IST midnight (18:30 UTC the previous day), not at UTC midnight.  Getting
 * this wrong would cause EOD queries to span the wrong day.
 *
 * Approach: use `Intl.DateTimeFormat.formatToParts` with `timeZone:
 * 'Asia/Kolkata'` to extract the day/month/year in IST, then reassemble as
 * ISO format.  This avoids:
 *  - `date.getDate()` which returns local-timezone values — wrong on UTC servers
 *  - Manual UTC offset arithmetic which breaks around DST on other timezones
 *
 * @param now  Optional Date to use instead of the real wall-clock time.
 *             Passing an explicit value makes this function pure and testable.
 */
export function istToday(now?: Date): string {
  const date = now ?? new Date();
  const parts = extractParts(_dateParts, date);
  // en-IN formatToParts gives day/month/year; reassemble as YYYY-MM-DD.
  // The `year`, `month`, `day` keys are guaranteed by the options we passed.
  const year = parts.year ?? '';
  const month = parts.month ?? '';
  const day = parts.day ?? '';
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Shared display formatting (BL-013 Phase 3)
//
// Every number, percentage, rupee amount and date a component shows goes through
// one of the functions below, so the same quantity never renders two ways.
// Components must not call Intl.*, toFixed or toLocaleString themselves.
// ---------------------------------------------------------------------------

/** What a missing value renders as, everywhere. */
export const EMPTY = '—';

type Num = number | null | undefined;

function usable(value: Num): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const _fixedCache = new Map<string, Intl.NumberFormat>();
function fixed(minDp: number, maxDp: number): Intl.NumberFormat {
  const key = `${minDp}:${maxDp}`;
  let formatter = _fixedCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: minDp,
      maximumFractionDigits: maxDp,
    });
    _fixedCache.set(key, formatter);
  }
  return formatter;
}

function signPrefix(value: number, sign: boolean): string {
  return sign && value > 0 ? '+' : '';
}

/**
 * A plain number with en-IN grouping and exactly `dp` decimals: 1234.5 → "1,234.50".
 * `trim` drops trailing zeros (up to `dp` decimals); `sign` adds "+" to positives.
 */
export function formatNumber(
  value: Num,
  dp = 2,
  options: { trim?: boolean; sign?: boolean } = {},
): string {
  if (!usable(value)) return EMPTY;
  return `${signPrefix(value, options.sign ?? false)}${fixed(options.trim ? 0 : dp, dp).format(value)}`;
}

/** A whole number with en-IN grouping: 123456 → "1,23,456". */
export function formatInt(value: Num): string {
  return usable(value) ? fixed(0, 0).format(Math.round(value)) : EMPTY;
}

/**
 * Rupees: "₹1,23,456", "-₹1,234.50". `dp` decimals (default 0); `trim` drops trailing
 * zeros; `sign` adds "+" to positives; `compact` switches to lakh / crore above ₹1 lakh
 * ("₹1.25 L", "₹3.40 Cr").
 */
export function formatInr(
  value: Num,
  options: { dp?: number; trim?: boolean; sign?: boolean; compact?: boolean } = {},
): string {
  if (!usable(value)) return EMPTY;
  const prefix = value < 0 ? '-' : signPrefix(value, options.sign ?? false);
  const abs = Math.abs(value);
  if (options.compact && abs >= 1e7) return `${prefix}₹${fixed(2, 2).format(abs / 1e7)} Cr`;
  if (options.compact && abs >= 1e5) return `${prefix}₹${fixed(2, 2).format(abs / 1e5)} L`;
  const dp = options.dp ?? 0;
  return `${prefix}₹${fixed(options.trim ? 0 : dp, dp).format(abs)}`;
}

interface PctOptions {
  /** Add "+" to positive values. */
  sign?: boolean;
  /** 'fraction' (default): 0.123 → 12.3%. 'percent': the value is already in percent units. */
  unit?: 'fraction' | 'percent';
}

/** A percentage: formatPct(0.1234) → "12.3%". Pass `{ unit: 'percent' }` for 12.34 → "12.3%". */
export function formatPct(value: Num, dp = 1, options: PctOptions = {}): string {
  if (!usable(value)) return EMPTY;
  const pct = options.unit === 'percent' ? value : value * 100;
  return `${signPrefix(pct, options.sign ?? false)}${fixed(dp, dp).format(pct)}%`;
}

/** A difference between two percentages, always signed: formatPp(0.012) → "+1.2 pp". */
export function formatPp(value: Num, dp = 1, options: Pick<PctOptions, 'unit'> = {}): string {
  if (!usable(value)) return EMPTY;
  const pp = options.unit === 'percent' ? value : value * 100;
  return `${signPrefix(pp, true)}${fixed(dp, dp).format(pp)} pp`;
}

/** A multiple: formatMultiple(1.234) → "1.2×". */
export function formatMultiple(value: Num, dp = 1): string {
  return usable(value) ? `${fixed(dp, dp).format(value)}×` : EMPTY;
}

const _istDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
const _istTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const _istTimeSeconds = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const _utcDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

type Instant = string | number | Date | null | undefined;

function toDate(value: Instant): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The IST calendar date of an instant: "05 Oct 2026". */
export function formatIstDate(value: Instant): string {
  const date = toDate(value);
  return date ? _istDate.format(date) : EMPTY;
}

/** The IST wall-clock time of an instant: "14:35" (or "14:35:07" with seconds). */
export function formatIstTime(value: Instant, options: { seconds?: boolean } = {}): string {
  const date = toDate(value);
  if (!date) return EMPTY;
  return (options.seconds ? _istTimeSeconds : _istTime).format(date);
}

/** IST date and time together: "05 Oct 2026, 14:35". */
export function formatIstDateTimeShort(
  value: Instant,
  options: { seconds?: boolean } = {},
): string {
  const date = toDate(value);
  return date ? `${_istDate.format(date)}, ${formatIstTime(date, options)}` : EMPTY;
}

/**
 * A calendar day that carries no time zone ("2026-10-05", a trading day or signal week):
 * "05 Oct 2026". Unlike formatIstDate it never shifts the day.
 */
export function formatDay(day: string | null | undefined): string {
  if (!day) return EMPTY;
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? EMPTY : _utcDate.format(date);
}

/** How long ago an instant was: "just now", "42s ago", "5 min ago", "3 h ago", "2 d ago". */
export function formatRelative(value: Instant, now: Date | number = Date.now()): string {
  const date = toDate(value);
  if (!date) return EMPTY;
  const seconds = Math.round((Number(now) - date.getTime()) / 1000);
  if (seconds < 0) return formatIstDateTimeShort(date);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

/** A duration in milliseconds: "4.2s" under ten seconds, "37s", then "2m 05s". */
export function formatDuration(ms: Num): string {
  if (!usable(ms)) return EMPTY;
  if (ms < 10_000) return `${fixed(1, 1).format(ms / 1000)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
