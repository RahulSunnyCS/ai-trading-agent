/**
 * Scheduled Entry Engine — T-15
 *
 * Decides whether a new paper trade entry is allowed at any given moment,
 * based on three independent gates:
 *   1. Fixed-time windows in IST (e.g. 09:20–14:30)
 *   2. An absolute no-entry deadline (e.g. 14:45)
 *   3. Event-day block (RBI policy, budget, F&O expiry mornings)
 *   4. Daily loss cap
 *
 * All time arithmetic uses UTC arithmetic + a fixed IST offset rather than
 * host TZ settings, so results are identical regardless of server locale.
 */

import type { Clock } from '../utils/clock';

// IST is UTC+5:30 — a fixed offset with no daylight-saving transitions.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface EntryWindow {
  /** Window start in IST, 24-hour "HH:MM" format. */
  openIST: string;
  /** Window end in IST, 24-hour "HH:MM" format (exclusive — a trade at exactly this minute is outside). */
  closeIST: string;
}

export interface ScheduledEntryConfig {
  /** Time windows during which new entries are allowed. Default: [{ openIST: '09:20', closeIST: '14:30' }]. */
  entryWindows: EntryWindow[];
  /** Hard cutoff — never open a new entry at or after this IST time. Default: '14:45'. */
  noEntryAfterIST: string;
  /** Injectable clock for testability. Use RealClock in production. */
  clock: Clock;
}

export interface EntryDecision {
  allowed: boolean;
  /** Human-readable explanation of why entry was allowed or denied. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Parse an "HH:MM" string and return total minutes since midnight.
 *
 * Using minutes-since-midnight as the unit makes window comparisons a simple
 * integer inequality, avoiding any string-comparison edge cases around
 * midnight rollovers.
 */
function parseHHMMToMinutes(hhMM: string): number {
  // Split is safe here: the format is always "HH:MM" (two digits, colon, two digits).
  const colonIndex = hhMM.indexOf(':');
  const hours = Number.parseInt(hhMM.slice(0, colonIndex), 10);
  const minutes = Number.parseInt(hhMM.slice(colonIndex + 1), 10);
  return hours * 60 + minutes;
}

/**
 * Return minutes since midnight in IST for the moment the given clock reports.
 *
 * Arithmetic approach: shift the UTC timestamp by the IST offset, then read
 * UTC hours/minutes from the adjusted instant. This is immune to TZ
 * configuration on the host and produces identical results in every locale.
 */
function getISTMinutes(clock: Clock): number {
  const istMs = clock.timestamp() + IST_OFFSET_MS;
  const d = new Date(istMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Determine whether a new entry is allowed right now, based on configured IST
 * entry windows and the hard no-entry deadline.
 *
 * Logic (evaluated in order):
 *   1. If the current IST time is >= noEntryAfterIST → deny.
 *   2. If the current IST time is inside any configured entryWindow → allow.
 *   3. Otherwise → deny (outside all windows).
 *
 * The deadline check runs first so that a window whose closeIST would extend
 * beyond noEntryAfterIST is still clamped by the deadline.
 *
 * Window boundary semantics: [open, close) — open is inclusive, close is
 * exclusive. A trade placed at exactly closeIST is outside the window.
 */
export function isWithinEntryWindow(config: ScheduledEntryConfig): EntryDecision {
  const nowMinutes = getISTMinutes(config.clock);
  const deadlineMinutes = parseHHMMToMinutes(config.noEntryAfterIST);

  // Gate 1: hard no-entry deadline — checked before windows so a window that
  // extends past the deadline cannot override the deadline.
  if (nowMinutes >= deadlineMinutes) {
    return {
      allowed: false,
      reason: `after no-entry deadline of ${config.noEntryAfterIST} IST`,
    };
  }

  // Gate 2: at least one entry window must contain the current time.
  for (const window of config.entryWindows) {
    const openMinutes = parseHHMMToMinutes(window.openIST);
    const closeMinutes = parseHHMMToMinutes(window.closeIST);

    if (nowMinutes >= openMinutes && nowMinutes < closeMinutes) {
      return { allowed: true, reason: 'within entry window' };
    }
  }

  // No window matched.
  return { allowed: false, reason: 'outside entry window' };
}

/**
 * Return true if the given date falls on any of the listed event dates.
 *
 * Comparison is on the YYYY-MM-DD portion only — the time component of `date`
 * is ignored. `eventDates` are ISO date strings in 'YYYY-MM-DD' format.
 *
 * This function does NOT use a Clock because the caller controls which date to
 * test — typically clock.now() — giving callers full flexibility (e.g. checking
 * the next trading day's event list).
 */
export function isEventDay(date: Date, eventDates: string[]): boolean {
  // Build the YYYY-MM-DD string from the Date using UTC methods to avoid
  // any local-TZ offset that could shift the date across a midnight boundary.
  // The IST date (which is what matters for Indian market event days) should
  // be derived by the caller using IST arithmetic before passing `date` here.
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  return eventDates.includes(dateStr);
}

/**
 * Check whether the running daily P&L has breached the configured loss cap.
 *
 * @param currentPnl  - Running P&L for today (negative = loss, positive = gain).
 * @param dailyLossCap - Maximum permitted loss as a positive number (e.g. 5000
 *                       means the session is halted if P&L reaches -5000).
 *
 * Boundary: breached when currentPnl <= -dailyLossCap (inclusive), matching
 * the task spec requirement that exactly -cap triggers a block.
 */
export function checkDailyLossCap(currentPnl: number, dailyLossCap: number): EntryDecision {
  if (currentPnl <= -dailyLossCap) {
    return { allowed: false, reason: 'daily loss cap breached' };
  }
  return { allowed: true, reason: 'within daily loss limit' };
}
