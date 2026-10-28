import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Underlying, lotSize } from '@trading/market-reference';
import type { Job } from '../jobs.js';
import type { Builtin } from '../runner.js';
import { addDays, istDay, tradingDays, weekdayOf } from '../schedule.js';
import { type CalendarReaders, REFERENCE_DIR, diskReaders } from './calendar.js';
import { type CheckResult, checkBuiltin, checkJob } from './types.js';

// BL-012 inventory S1, S2 and Y4: reference data that goes stale when an exchange revises it.
// The checks only look; they never edit a CSV or the catalog.

export const FYERS_NSE_FO_URL = 'https://public.fyers.in/sym_details/NSE_FO.csv';
export const NIFTY50_LIVE_URL = 'https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv';
export const MEMBERSHIP_CSV =
  'packages/momentum-backtesting/src/momentum_backtesting/stocks/curated/nifty50_membership.csv';

/** Underlyings in the NSE F&O symbol master that `lot_sizes.csv` tracks (SENSEX is BSE). */
const NSE_UNDERLYINGS: Underlying[] = ['NIFTY', 'BANKNIFTY'];

/** Fyers symbol-master columns (0-based): minimum lot size and underlying symbol. */
const COL_LOT = 3;
const COL_UNDERLYING = 13;

export type Fetcher = (url: string) => Promise<string>;

export const httpFetch: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '');
}

/** Lot sizes per underlying as the Fyers master lists them (a set, so a mixed listing shows). */
export function masterLotSizes(csv: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const line of lines(csv)) {
    const cells = line.split(',');
    const underlying = cells[COL_UNDERLYING]?.trim();
    const lot = Number(cells[COL_LOT]);
    if (!underlying || !Number.isInteger(lot) || lot <= 0) continue;
    const set = out.get(underlying) ?? new Set<number>();
    set.add(lot);
    out.set(underlying, set);
  }
  return out;
}

export async function checkLotSizes(fetcher: Fetcher, asOf: Date): Promise<CheckResult> {
  let csv: string;
  try {
    csv = await fetcher(FYERS_NSE_FO_URL);
  } catch (error) {
    return { ok: false, detail: `could not reach the Fyers symbol master: ${String(error)}` };
  }
  const master = masterLotSizes(csv);
  const mismatches: string[] = [];
  const checked: string[] = [];
  for (const underlying of NSE_UNDERLYINGS) {
    const lots = master.get(underlying);
    if (!lots) {
      return {
        ok: false,
        detail: `the Fyers symbol master has no ${underlying} rows (format changed?)`,
      };
    }
    const mine = lotSize(underlying, asOf);
    checked.push(`${underlying} ${mine}`);
    if (lots.size !== 1 || !lots.has(mine)) {
      mismatches.push(`${underlying}: lot_sizes.csv ${mine}, Fyers ${[...lots].join('/')}`);
    }
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      detail: `lot size differs from the Fyers symbol master — ${mismatches.join('; ')}`,
    };
  }
  return { ok: true, detail: `lot sizes match the Fyers symbol master (${checked.join(', ')})` };
}

/** Symbols of the live niftyindices list (CSV with a `Symbol` column). */
export function liveSymbols(csv: string): string[] {
  const [header, ...rows] = lines(csv);
  const cols = (header ?? '').split(',').map((c) => c.trim());
  const i = cols.indexOf('Symbol');
  if (i < 0) throw new Error('no Symbol column in the niftyindices list');
  return rows.map((r) => (r.split(',')[i] ?? '').trim()).filter(Boolean);
}

/** Symbols of rows with an empty `to` in nifty50_membership.csv (first four cells are unquoted). */
export function openMembers(csv: string): string[] {
  const [, ...rows] = lines(csv);
  const out: string[] = [];
  for (const row of rows) {
    const [, symbol, , to] = row.split(',');
    if (symbol && (to ?? '').trim() === '') out.push(symbol.trim());
  }
  return out;
}

export async function checkNifty50(
  fetcher: Fetcher,
  readMembership: () => string,
): Promise<CheckResult> {
  let live: string[];
  try {
    live = liveSymbols(await fetcher(NIFTY50_LIVE_URL));
  } catch (error) {
    return { ok: false, detail: `could not reach niftyindices.com: ${String(error)}` };
  }
  if (live.length < 40) {
    return {
      ok: false,
      detail: `the niftyindices list has only ${live.length} symbols (format changed?)`,
    };
  }
  const file = new Set(openMembers(readMembership()));
  const liveSet = new Set(live);
  const added = live.filter((s) => !file.has(s)).sort();
  const removed = [...file].filter((s) => !liveSet.has(s)).sort();
  if (added.length === 0 && removed.length === 0) {
    return {
      ok: true,
      detail: `Nifty 50 list matches the membership file (${live.length} symbols)`,
    };
  }
  const parts: string[] = [];
  if (added.length) parts.push(`in the live index but not the file: ${added.join(', ')}`);
  if (removed.length) parts.push(`in the file but not the live index: ${removed.join(', ')}`);
  return { ok: false, detail: `Nifty 50 membership changed — ${parts.join('; ')}` };
}

// BL-012 inventory Y4: the expiry rules (`expiry_calendar.csv`) and strike steps
// (`strike_step.csv`) against what the exchanges list today. NSE and BSE announce a new expiry
// weekday or strike interval by circular, and the listed contracts change with it, so the
// symbol master shows the change without anyone having read the circular. Only live listings
// are judged: the rules' history (NIFTY shown as Tuesday back to 2018, TODO 3.10.15) is separate
// work. Holiday shifts use holidays.csv (NSE's list; BSE closes on the same days in practice).

export const FYERS_BSE_FO_URL = 'https://public.fyers.in/sym_details/BSE_FO.csv';

/** Fyers symbol-master columns (0-based): expiry (epoch seconds), strike, option type. */
const COL_EXPIRY = 8;
const COL_STRIKE = 15;
const COL_OPTION = 16;

/** Upcoming rule expiries a WEEKLY underlying must have listed (MONTHLY_LAST: one). */
const WEEKLY_EXPECTED = 3;

/** Underlying -> expiry day (IST) -> listed strikes, options only. */
export function masterOptions(csv: string): Map<string, Map<string, number[]>> {
  const out = new Map<string, Map<string, number[]>>();
  for (const line of lines(csv)) {
    const cells = line.split(',');
    const type = cells[COL_OPTION]?.trim();
    if (type !== 'CE' && type !== 'PE') continue;
    const underlying = cells[COL_UNDERLYING]?.trim();
    const epoch = Number(cells[COL_EXPIRY]);
    const strike = Number(cells[COL_STRIKE]);
    if (!underlying || !(epoch > 0) || !Number.isFinite(strike)) continue;
    const day = istDay(new Date(epoch * 1000));
    const byExpiry = out.get(underlying) ?? new Map<string, number[]>();
    const strikes = byExpiry.get(day) ?? [];
    strikes.push(strike);
    byExpiry.set(day, strikes);
    out.set(underlying, byExpiry);
  }
  return out;
}

export interface ExpiryRule {
  underlying: string;
  /** `WEEKLY` or `MONTHLY_LAST`. */
  cadence: string;
  /** 0 = Monday … 6 = Sunday, as the CSV (Python's `date.weekday()`) has it. */
  weekday: number;
  effective: string;
}

interface StepRow {
  underlying: string;
  step: number;
  effective: string;
}

function dataRows(csv: string): string[][] {
  return lines(csv)
    .slice(1)
    .map((l) => l.split(',').map((c) => c.trim()));
}

export function parseExpiryRules(csv: string): ExpiryRule[] {
  return dataRows(csv)
    .map(([underlying = '', cadence = '', weekday = '', effective = '']) => ({
      underlying,
      cadence,
      weekday: Number(weekday),
      effective,
    }))
    .filter((r) => r.underlying !== '' && Number.isInteger(r.weekday));
}

function parseSteps(csv: string): StepRow[] {
  return dataRows(csv)
    .map(([underlying = '', step = '', effective = '']) => ({
      underlying,
      step: Number(step),
      effective,
    }))
    .filter((r) => r.underlying !== '' && r.step > 0);
}

/** The row in force on `day`: the latest whose effective date is on or before it. */
function inForce<T extends { underlying: string; effective: string }>(
  rows: T[],
  underlying: string,
  day: string,
): T | undefined {
  return rows
    .filter((r) => r.underlying === underlying && r.effective <= day)
    .sort((a, b) => a.effective.localeCompare(b.effective))
    .pop();
}

/** Python weekday (0 = Monday) of an IST calendar day. */
const pyWeekday = (day: string): number => (weekdayOf(day) + 6) % 7;

/** The day an expiry due on `day` trades: `day`, or the last trading day before it. */
function shiftedBack(day: string, holidays: Set<string>): string {
  let d = day;
  while (pyWeekday(d) >= 5 || holidays.has(d)) d = addDays(d, -1);
  return d;
}

/** The first day of the month after the one `day` is in. */
function nextMonthStart(day: string): string {
  const [y = 0, m = 0] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/** The last `weekday` (0 = Monday) of the month `day` is in. */
function lastWeekdayOfMonth(day: string, weekday: number): string {
  const last = addDays(nextMonthStart(day), -1);
  return addDays(last, -((pyWeekday(last) - weekday + 7) % 7));
}

/** The rule date (before any holiday shift) that `day` belongs to under `rule`. */
function ruleDateFor(day: string, rule: ExpiryRule): string {
  if (rule.cadence === 'MONTHLY_LAST') return lastWeekdayOfMonth(day, rule.weekday);
  return addDays(day, (rule.weekday - pyWeekday(day) + 7) % 7);
}

/** The rule's next expiries after `today`, holiday-shifted, within years the holiday list covers. */
export function expectedExpiries(
  rule: ExpiryRule,
  today: string,
  holidays: Set<string>,
  covered: (day: string) => boolean,
): string[] {
  const want = rule.cadence === 'MONTHLY_LAST' ? 1 : WEEKLY_EXPECTED;
  const out: string[] = [];
  let probe = addDays(today, 1);
  for (let guard = 0; out.length < want && guard < 12; guard++) {
    const ruleDay = ruleDateFor(probe, rule);
    if (!covered(ruleDay)) break;
    const due = shiftedBack(ruleDay, holidays);
    if (due > today) out.push(due);
    probe = rule.cadence === 'MONTHLY_LAST' ? nextMonthStart(probe) : addDays(ruleDay, 1);
  }
  return out;
}

/** The commonest gap between neighbouring listed strikes. */
export function modalStep(strikes: number[]): number | null {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (let i = 1; i < sorted.length; i++) {
    const gap = Math.round(((sorted[i] ?? 0) - (sorted[i - 1] ?? 0)) * 100) / 100;
    counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [gap, n] of counts) {
    if (n > bestCount) {
      best = gap;
      bestCount = n;
    }
  }
  return best;
}

export async function checkExpiryCalendar(
  fetcher: Fetcher,
  today: string,
  readers: CalendarReaders,
): Promise<CheckResult> {
  let listed: Map<string, Map<string, number[]>>;
  try {
    const [nse, bse] = await Promise.all([fetcher(FYERS_NSE_FO_URL), fetcher(FYERS_BSE_FO_URL)]);
    listed = masterOptions(`${nse}\n${bse}`);
  } catch (error) {
    return { ok: false, detail: `could not reach the Fyers symbol master: ${String(error)}` };
  }
  const holidayDays = dataRows(readers.readFile(`${REFERENCE_DIR}/holidays.csv`))
    .map((cells) => cells[0] ?? '')
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const holidays = new Set(holidayDays);
  // A year with no holiday row cannot be judged (its holiday shifts are unknown); the
  // calendar-upkeep check already asks for next year's holidays from 1 Dec.
  const years = new Set(holidayDays.map((d) => d.slice(0, 4)));
  const covered = (day: string) => years.has(day.slice(0, 4));

  const rules = parseExpiryRules(readers.readFile(`${REFERENCE_DIR}/expiry_calendar.csv`));
  const problems: string[] = [];
  const rulesFine: string[] = [];
  for (const underlying of [...new Set(rules.map((r) => r.underlying))].sort()) {
    const rule = inForce(rules, underlying, today);
    if (!rule) continue;
    const expiries = [...(listed.get(underlying)?.keys() ?? [])].filter((d) => d >= today).sort();
    if (expiries.length === 0) {
      problems.push(`${underlying}: no options in the Fyers symbol master (format changed?)`);
      continue;
    }
    const off = expiries.filter((e) => {
      if (!covered(e)) return false;
      const r = inForce(rules, underlying, e) ?? rule;
      return shiftedBack(ruleDateFor(e, r), holidays) !== e;
    });
    const listedSet = new Set(expiries);
    const missing = expectedExpiries(rule, today, holidays, covered).filter(
      (d) => !listedSet.has(d),
    );
    if (off.length > 0) {
      const more = off.length > 4 ? ` and ${off.length - 4} more` : '';
      problems.push(
        `${underlying}: listed expiries off the ${rule.cadence} weekday-${rule.weekday} rule: ${off.slice(0, 4).join(', ')}${more}`,
      );
    }
    if (missing.length > 0) {
      problems.push(
        `${underlying}: the rule's next expiries are not listed: ${missing.join(', ')}`,
      );
    }
    if (off.length === 0 && missing.length === 0) rulesFine.push(underlying);
  }

  const steps = parseSteps(readers.readFile(`${REFERENCE_DIR}/strike_step.csv`));
  const stepsFine: string[] = [];
  for (const underlying of [...new Set(steps.map((s) => s.underlying))].sort()) {
    const mine = inForce(steps, underlying, today);
    const byExpiry = listed.get(underlying);
    // An underlying with no listed options here is judged by the expiry rules above (when it
    // has one) or is simply not traded any more; its step is not the problem either way.
    if (!mine || !byExpiry) continue;
    const nearest = [...byExpiry.keys()].filter((d) => d >= today).sort()[0];
    const theirs = nearest ? modalStep(byExpiry.get(nearest) ?? []) : null;
    if (theirs === null) continue;
    if (theirs !== mine.step) {
      problems.push(
        `${underlying}: strike_step.csv ${mine.step}, listed strikes ${theirs} apart (${nearest} expiry)`,
      );
    } else {
      stepsFine.push(`${underlying} ${mine.step}`);
    }
  }

  if (problems.length > 0) {
    return {
      ok: false,
      detail: `expiry rules or strike steps differ from the exchange listings — ${problems.join('; ')}`,
    };
  }
  return {
    ok: true,
    detail: `listed expiries follow expiry_calendar.csv (${rulesFine.join(', ')}); strike steps match (${stepsFine.join(', ')})`,
  };
}

export const jobs: Job[] = [
  checkJob({
    id: 'check-lot-sizes',
    description: 'Compare lot_sizes.csv with the Fyers NSE F&O symbol master',
    schedule: { at: '17:00', on: tradingDays, label: 'trading days 17:00' },
    builtin: 'check-lot-sizes',
    retries: 2,
    retryDelayMinutes: 30,
    fixHint:
      "cd packages/trading-data && uv run tdata reference sql \"INSERT INTO ref_lot_sizes VALUES ('NIFTY', <new lot>, DATE '<effective date>')\"  (one row per changed underlying)",
  }),
  checkJob({
    id: 'check-nifty50-membership',
    description: 'Compare the live Nifty 50 list with nifty50_membership.csv',
    schedule: { at: '08:30', on: tradingDays, label: 'trading days 08:30' },
    builtin: 'check-nifty50-membership',
    retries: 2,
    retryDelayMinutes: 30,
    needs: ['home'],
    fixHint: `Edit ${MEMBERSHIP_CSV} (and the curated companies/aliases), then: cd packages/momentum-backtesting && uv run mbt stocks fetch && uv run mbt stocks pin-manifest`,
  }),
  checkJob({
    id: 'check-expiry-calendar',
    description:
      'Compare expiry_calendar.csv and strike_step.csv with the expiries and strikes NSE and BSE list (Y4)',
    schedule: { at: '17:05', on: tradingDays, label: 'trading days 17:05' },
    builtin: 'check-expiry-calendar',
    retries: 2,
    retryDelayMinutes: 30,
    fixHint:
      "Find the NSE/BSE circular, then: cd packages/trading-data && uv run tdata reference sql \"INSERT INTO ref_expiry_rules VALUES ('NIFTY', 'WEEKLY', <weekday, 0 = Monday>, DATE '<effective date>')\"  (cadence WEEKLY or MONTHLY_LAST; a strike interval: INSERT INTO ref_strike_steps VALUES ('NIFTY', <step>, DATE '<effective date>')), then uv run tdata reference derive-expiries",
  }),
];

export const builtins: Record<string, Builtin> = {
  'check-lot-sizes': checkBuiltin((ctx) => checkLotSizes(httpFetch, ctx.now())),
  'check-expiry-calendar': checkBuiltin((ctx) =>
    checkExpiryCalendar(httpFetch, istDay(ctx.now()), diskReaders(ctx.repoRoot)),
  ),
  'check-nifty50-membership': checkBuiltin((ctx) =>
    checkNifty50(httpFetch, () => readFileSync(join(ctx.repoRoot, MEMBERSHIP_CSV), 'utf8')),
  ),
};
