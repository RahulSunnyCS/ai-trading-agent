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
  const n = typeof v === 'number' ? v : parseFloat(v);
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
function extractParts(
  formatter: Intl.DateTimeFormat,
  date: Date,
): Record<string, string> {
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
  const year = parts['year'] ?? '';
  const month = parts['month'] ?? '';
  const day = parts['day'] ?? '';
  return `${year}-${month}-${day}`;
}
