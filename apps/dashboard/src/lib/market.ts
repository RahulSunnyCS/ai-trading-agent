/**
 * Market-session and token-expiry clock maths for the shell (status cluster, token banner,
 * Broker logins card). Pure functions of an explicit `now`, correct in IST whatever the host
 * time zone is: IST is a fixed UTC+05:30 with no daylight saving, so the IST wall clock is
 * read by shifting the instant and using the UTC getters.
 */

import { formatIstTime } from './format';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** NSE cash / F&O session boundaries, in minutes after IST midnight. */
const PRE_OPEN_START_MIN = 9 * 60;
const OPEN_START_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export type MarketState = 'pre_open' | 'open' | 'closed';

export interface MarketSession {
  state: MarketState;
  /** "Market open" / "Pre-open" / "Market closed". */
  label: string;
  /** The next instant the state changes. */
  nextChange: Date;
}

const LABELS: Record<MarketState, string> = {
  pre_open: 'Pre-open',
  open: 'Market open',
  closed: 'Market closed',
};

/** IST calendar day index (days since the epoch, counted in IST). */
function istDayIndex(now: Date): number {
  return Math.floor((now.getTime() + IST_OFFSET_MS) / DAY_MS);
}

/** Day of week in IST: 0 = Sunday … 6 = Saturday. (The epoch, day 0, was a Thursday.) */
function istWeekday(dayIndex: number): number {
  return (((dayIndex + 4) % 7) + 7) % 7;
}

/** The instant of `minutes` past IST midnight on IST day `dayIndex`. */
function istInstant(dayIndex: number, minutes: number): Date {
  return new Date(dayIndex * DAY_MS + minutes * MINUTE_MS - IST_OFFSET_MS);
}

function isWeekday(dayIndex: number): boolean {
  const dow = istWeekday(dayIndex);
  return dow >= 1 && dow <= 5;
}

/**
 * The NSE cash / F&O session at `now`: pre-open 09:00–09:15 IST, open 09:15–15:30 IST, Monday
 * to Friday; closed otherwise.
 *
 * Weekday-only: exchange holidays are NOT known here, so a holiday that falls on a weekday
 * reads as a normal session, and special sessions (Muhurat trading, a Saturday session) read
 * as closed.
 */
export function marketSession(now: Date): MarketSession {
  const day = istDayIndex(now);
  const msIntoDay = now.getTime() + IST_OFFSET_MS - day * DAY_MS;

  let state: MarketState = 'closed';
  let nextChange: Date;

  if (isWeekday(day) && msIntoDay < CLOSE_MIN * MINUTE_MS) {
    if (msIntoDay < PRE_OPEN_START_MIN * MINUTE_MS) {
      nextChange = istInstant(day, PRE_OPEN_START_MIN);
    } else if (msIntoDay < OPEN_START_MIN * MINUTE_MS) {
      state = 'pre_open';
      nextChange = istInstant(day, OPEN_START_MIN);
    } else {
      state = 'open';
      nextChange = istInstant(day, CLOSE_MIN);
    }
  } else {
    // After the close, or a weekend: the next weekday's pre-open.
    let next = day + 1;
    while (!isWeekday(next)) next += 1;
    nextChange = istInstant(next, PRE_OPEN_START_MIN);
  }

  return { state, label: LABELS[state], nextChange };
}

/**
 * Whether live momentum scores can be asked for (BL-051): a Friday during the open session,
 * 09:15–15:30 IST. The service answers the same question itself; this only decides whether the
 * Scores page offers the switch.
 */
export function isLiveScoresWindow(now: Date): boolean {
  return istWeekday(istDayIndex(now)) === 5 && marketSession(now).state === 'open';
}

/**
 * The session in words: "Market open · closes 15:30", "Pre-open · opens 09:15",
 * "Market closed · opens 09:00" (later today) or "Market closed · opens Mon 09:00".
 * "Opens" after a close means the pre-open at 09:00; times are IST.
 */
export function describeMarketSession(now: Date): string {
  const { state, label, nextChange } = marketSession(now);
  const time = formatIstTime(nextChange);
  if (state === 'open') return `${label} · closes ${time}`;
  if (state === 'pre_open') return `${label} · opens ${time}`;
  const nextDay = istDayIndex(nextChange);
  if (nextDay === istDayIndex(now)) return `${label} · opens ${time}`;
  return `${label} · opens ${WEEKDAYS[istWeekday(nextDay)]} ${time}`;
}

// ---------------------------------------------------------------------------
// Token expiry
// ---------------------------------------------------------------------------

/** A token with this long or less to live counts as `expiring` (matches the server's
 * near-expiry threshold in `jobs/token-validity-check.ts`). */
export const TOKEN_EXPIRING_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export type TokenState = 'valid' | 'expiring' | 'expired' | 'missing';

/** Milliseconds until `expiresAt` (negative once past), or null when absent or unparseable. */
export function msUntil(expiresAt: string | null | undefined, now: Date): number | null {
  if (!expiresAt) return null;
  const at = new Date(expiresAt).getTime();
  return Number.isNaN(at) ? null : at - now.getTime();
}

/** Where a token with this expiry stands at `now`. No (or an unparseable) expiry is `missing`. */
export function tokenState(expiresAt: string | null | undefined, now: Date): TokenState {
  const left = msUntil(expiresAt, now);
  if (left === null) return 'missing';
  if (left <= 0) return 'expired';
  if (left <= TOKEN_EXPIRING_THRESHOLD_MS) return 'expiring';
  return 'valid';
}

/**
 * Time left, rounded down to the minute: "1h 42m", "2h", "12m", and "under a minute" below
 * sixty seconds (including zero and negative values; check `tokenState` for expiry first).
 */
export function formatCountdown(msLeft: number): string {
  if (!Number.isFinite(msLeft) || msLeft < MINUTE_MS) return 'under a minute';
  const totalMinutes = Math.floor(msLeft / MINUTE_MS);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
