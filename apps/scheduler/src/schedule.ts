import { isTradingDay } from '@trading/market-reference';

/**
 * Time and schedules, all in IST. India has no daylight saving, so IST is a
 * fixed UTC+05:30 and plain offset arithmetic is exact. This deliberately does
 * not depend on the machine's timezone: launchd fires in local time, but the
 * scheduler's own decisions must not change if the Mac's zone does.
 */
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** IST calendar date 'YYYY-MM-DD' of an instant. */
export function istDay(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant of `hhmm` IST on the IST calendar date `day`. */
export function istAt(day: string, hhmm: string): Date {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${day}T00:00:00Z`) + (h * 60 + m) * 60_000 - IST_OFFSET_MS);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for an IST calendar date. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/**
 * Which days a job runs. A predicate rather than a cron string: "trading days"
 * and "first Sunday of the month" are not expressible in cron, and a predicate
 * is trivially testable.
 */
export type DayRule = (day: string) => boolean;

/** Mon–Fri except NSE holidays (holidays.csv via @trading/market-reference). */
export const tradingDays: DayRule = (day) => isTradingDay(day);

export const everyDay: DayRule = () => true;

/** On these weekdays (0 = Sunday … 6 = Saturday), holidays included. */
export const onWeekdays =
  (...days: number[]): DayRule =>
  (day) =>
    days.includes(weekdayOf(day));

export interface Schedule {
  /** IST wall-clock time, 'HH:MM'. */
  at: string;
  on: DayRule;
  /** How `status` describes it, e.g. 'trading days 08:00'. */
  label: string;
}

/** Search horizon: long enough for yearly jobs. */
const HORIZON_DAYS = 400;

/** The most recent scheduled instant at or before `now`, or null. */
export function previousDue(s: Schedule, now: Date): Date | null {
  const today = istDay(now);
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const day = addDays(today, -i);
    const at = istAt(day, s.at);
    if (s.on(day) && at.getTime() <= now.getTime()) return at;
  }
  return null;
}

/** The first scheduled instant strictly after `now`, or null. */
export function nextDue(s: Schedule, now: Date): Date | null {
  const today = istDay(now);
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const day = addDays(today, i);
    const at = istAt(day, s.at);
    if (s.on(day) && at.getTime() > now.getTime()) return at;
  }
  return null;
}

/** 'Fri 06 Oct 14:40' in IST — for status output and alerts. */
export function formatIst(at: Date): string {
  return at.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
