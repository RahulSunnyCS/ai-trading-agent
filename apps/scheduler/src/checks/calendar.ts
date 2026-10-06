import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from '../jobs.js';
import type { Builtin } from '../runner.js';
import { addDays, istDay, tradingDays } from '../schedule.js';
import { type CheckResult, checkBuiltin, checkJob } from './types.js';

/**
 * Calendar upkeep (BL-012 inventory Y1, Y2, M3). Reference data that is edited by hand
 * and goes quietly wrong when nobody remembers to extend it. Alert only: these checks
 * read the files, they never edit them.
 */

const REFERENCE_DIR = 'packages/option-backtesting/src/option_backtesting/data/reference';
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
];

export const builtins: Record<string, Builtin> = {
  'calendar-upkeep': checkBuiltin((ctx) =>
    checkCalendars(istDay(ctx.now()), diskReaders(ctx.repoRoot)),
  ),
  'margin-reminder': checkBuiltin((ctx) =>
    checkMargin(istDay(ctx.now()), diskReaders(ctx.repoRoot)),
  ),
};
