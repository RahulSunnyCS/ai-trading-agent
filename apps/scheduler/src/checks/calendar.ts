import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from '../jobs.js';
import type { Builtin } from '../runner.js';
import { addDays, istDay, tradingDays } from '../schedule.js';
import { type CheckResult, checkBuiltin, checkJob } from './types.js';

/**
 * Calendar upkeep (BL-012 inventory Y1, Y2, Y3, M3). Reference data that is edited by hand
 * and goes quietly wrong when nobody remembers to extend it. Alert only: these checks
 * read the files, they never edit them.
 */

export const REFERENCE_DIR = 'packages/option-backtesting/src/option_backtesting/data/reference';
const MIGRATIONS_DIR = 'apps/server/src/db/migrations';

/** The RBI MPC calendar must run at least this far ahead. */
export const RBI_MIN_DAYS_AHEAD = 45;

/** Readers, injected so tests need no files. */
export interface CalendarReaders {
  /** Text of a file under the repo root. */
  readFile: (relPath: string) => string;
  /** File names in a directory under the repo root. */
  listDir: (relPath: string) => string[];
}

export function diskReaders(repoRoot: string): CalendarReaders {
  return {
    readFile: (rel) => readFileSync(join(repoRoot, rel), 'utf8'),
    listDir: (rel) => readdirSync(join(repoRoot, rel)),
  };
}

/** Column `index` of every data row (header skipped), trimmed, blanks dropped. */
function column(csv: string, index: number): string[] {
  return csv
    .split('\n')
    .slice(1)
    .map((line) => line.split(',')[index]?.trim() ?? '')
    .filter((v) => v !== '');
}

export function checkHolidays(today: string, readers: CalendarReaders): CheckResult {
  const dates = column(readers.readFile(`${REFERENCE_DIR}/holidays.csv`), 0)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const last = dates[dates.length - 1];
  if (last === undefined) return { ok: false, detail: 'holidays.csv has no rows' };
  const next = Number(today.slice(0, 4)) + 1;
  if (last < today) {
    return { ok: false, detail: `holidays.csv ends on ${last}, which is in the past` };
  }
  const hasNext = dates.some((d) => d.startsWith(`${next}-`));
  if (!hasNext && today.slice(5, 7) === '12') {
    return { ok: false, detail: `no ${next} trading holidays in holidays.csv (last row ${last})` };
  }
  return {
    ok: true,
    detail: hasNext
      ? `${next} holidays present (last row ${last})`
      : `holidays run to ${last}; ${next} is due from 1 Dec`,
  };
}

const RBI_ROW = /\(\s*'(\d{4}-\d{2}-\d{2})'\s*,\s*'RBI_POLICY'/g;

export function checkRbiDates(today: string, readers: CalendarReaders): CheckResult {
  const dates: string[] = [];
  for (const file of readers.listDir(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
    const sql = readers.readFile(`${MIGRATIONS_DIR}/${file}`);
    for (const m of sql.matchAll(RBI_ROW)) if (m[1]) dates.push(m[1]);
  }
  dates.sort();
  const last = dates[dates.length - 1];
  if (last === undefined) return { ok: false, detail: 'no RBI_POLICY rows in any migration' };
  if (last < addDays(today, RBI_MIN_DAYS_AHEAD)) {
    return {
      ok: false,
      detail: `RBI MPC dates end on ${last}, under ${RBI_MIN_DAYS_AHEAD} days ahead of ${today}`,
    };
  }
  return { ok: true, detail: `RBI MPC dates run to ${last}` };
}

export function checkMargin(today: string, readers: CalendarReaders): CheckResult {
  const months = column(readers.readFile(`${REFERENCE_DIR}/margin.csv`), 2)
    .filter((m) => /^\d{4}-\d{2}$/.test(m))
    .sort();
  const latest = months[months.length - 1];
  const current = today.slice(0, 7);
  if (latest === undefined) return { ok: false, detail: 'margin.csv has no rows' };
  if (latest < current) {
    return {
      ok: false,
      detail: `margin.csv's latest month is ${latest}; this month is ${current}`,
    };
  }
  return { ok: true, detail: `margin.csv covers ${latest}` };
}

/** Holiday and RBI checks together; a problem in either fails the job. */
export function checkCalendars(today: string, readers: CalendarReaders): CheckResult {
  const results = [checkHolidays(today, readers), checkRbiDates(today, readers)];
  return {
    ok: results.every((r) => r.ok),
    detail: results.map((r) => r.detail).join('; '),
  };
}

/** The first trading day of its month (the margin reminder's day). */
export function firstTradingDayOfMonth(day: string): boolean {
  if (!tradingDays(day)) return false;
  const month = day.slice(0, 8);
  for (let d = 1; d < Number(day.slice(8, 10)); d++) {
    if (tradingDays(`${month}${String(d).padStart(2, '0')}`)) return false;
  }
  return true;
}

/**
 * BL-012 inventory Y3: `BLOCKED_DATES` in the repo `.env`, a JSON array of days the frozen
 * personality engine refuses to enter on (`apps/server/src/signals/personality-filter.ts`).
 * It is edited by hand once a year. The check cannot say which days belong in it; it says when
 * the list is broken (the engine then silently ignores all of it), names days that cannot be
 * meant (a weekend or an NSE holiday from today on), and from 1 Dec asks for next year's.
 * Unset or empty passes: the engine then blocks nothing, which is a choice, not drift.
 */
export function checkBlockedDates(
  today: string,
  raw: string | undefined,
  isTradingDay: (day: string) => boolean = tradingDays,
): CheckResult {
  if (raw === undefined || raw.trim() === '') {
    return { ok: true, detail: 'BLOCKED_DATES is not set (the engine blocks no date)' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      detail: 'BLOCKED_DATES is not valid JSON, so the engine ignores the whole list',
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      detail: 'BLOCKED_DATES is not a JSON array, so the engine ignores the whole list',
    };
  }
  const bad = parsed.filter((v) => typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v));
  if (bad.length > 0) {
    return {
      ok: false,
      detail: `BLOCKED_DATES has ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} that are not 'YYYY-MM-DD' (${bad
        .slice(0, 3)
        .map((v) => JSON.stringify(v))
        .join(', ')}), which never match a day`,
    };
  }
  const dates = (parsed as string[]).slice().sort();
  const last = dates[dates.length - 1];
  if (last === undefined) {
    return { ok: true, detail: 'BLOCKED_DATES is empty (the engine blocks no date)' };
  }
  const problems: string[] = [];
  const closed = dates.filter((d) => d >= today && !isTradingDay(d));
  if (closed.length > 0) {
    problems.push(`BLOCKED_DATES lists days the market is closed: ${closed.join(', ')}`);
  }
  const next = Number(today.slice(0, 4)) + 1;
  if (last < today) {
    problems.push(`every BLOCKED_DATES day is in the past (last ${last})`);
  } else if (today.slice(5, 7) === '12' && !dates.some((d) => d.startsWith(`${next}-`))) {
    problems.push(`BLOCKED_DATES has no ${next} days (last ${last})`);
  }
  if (problems.length > 0) return { ok: false, detail: problems.join('; ') };
  return {
    ok: true,
    detail: `BLOCKED_DATES: ${dates.filter((d) => d >= today).length} day(s) ahead, last ${last}`,
  };
}

const BLOCKED_DATES_FIX =
  'Edit BLOCKED_DATES in the repo-root .env: a one-line JSON array of the days the frozen engine must not trade, e.g. ["2027-01-26"], from the NSE holiday and expiry calendars and the RBI MPC dates; or delete the line while the frozen engine stays off. The scheduler reads .env at start, so restart it afterwards';

const HOLIDAY_FIX =
  "Add the dates from NSE's holiday circular: cd packages/trading-data && uv run tdata reference sql \"INSERT INTO ref_holidays VALUES (DATE 'YYYY-MM-DD', 'Name')\" (one per holiday). For RBI dates add a new apps/server/src/db/migrations/NNN_*.sql inserting into event_calendar (event_type RBI_POLICY), then bun run migrate";
const MARGIN_FIX =
  "Add this month's margin: cd packages/trading-data && uv run tdata reference sql \"INSERT INTO ref_margins VALUES ('NIFTY', 'short-straddle', 'YYYY-MM', 140000)\" using the broker's current SPAN figure";

export const jobs: Job[] = [
  checkJob({
    id: 'calendar-upkeep',
    description: "Check next year's NSE holidays and the RBI MPC dates are in the reference data",
    schedule: { at: '08:35', on: tradingDays, label: 'trading days 08:35' },
    builtin: 'calendar-upkeep',
    fixHint: HOLIDAY_FIX,
  }),
  checkJob({
    id: 'margin-reminder',
    description: "Remind to load the new month's margin table",
    schedule: {
      at: '08:35',
      on: firstTradingDayOfMonth,
      label: 'first trading day of the month 08:35',
    },
    catchUpHours: 72,
    builtin: 'margin-reminder',
    fixHint: MARGIN_FIX,
  }),
  checkJob({
    id: 'check-blocked-dates',
    description: "Check .env's BLOCKED_DATES parses and has next year's days from 1 Dec (Y3)",
    schedule: { at: '08:35', on: tradingDays, label: 'trading days 08:35' },
    builtin: 'check-blocked-dates',
    fixHint: BLOCKED_DATES_FIX,
  }),
];

export const builtins: Record<string, Builtin> = {
  'calendar-upkeep': checkBuiltin((ctx) =>
    checkCalendars(istDay(ctx.now()), diskReaders(ctx.repoRoot)),
  ),
  'margin-reminder': checkBuiltin((ctx) =>
    checkMargin(istDay(ctx.now()), diskReaders(ctx.repoRoot)),
  ),
  'check-blocked-dates': checkBuiltin((ctx) =>
    checkBlockedDates(istDay(ctx.now()), ctx.env.BLOCKED_DATES),
  ),
};
