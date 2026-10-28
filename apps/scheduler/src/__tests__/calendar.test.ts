import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type CalendarReaders,
  checkBlockedDates,
  checkCalendars,
  checkHolidays,
  checkMargin,
  checkRbiDates,
  diskReaders,
  firstTradingDayOfMonth,
} from '../checks/calendar.js';

function fake(files: Record<string, string>): CalendarReaders {
  return {
    readFile: (p) => {
      const hit = Object.entries(files).find(([k]) => p.endsWith(k));
      if (!hit) throw new Error(`no ${p}`);
      return hit[1];
    },
    listDir: (p) =>
      Object.keys(files).filter((k) => k.endsWith('.sql') && p.endsWith('migrations')),
  };
}

const holidays = (...dates: string[]) =>
  fake({ 'holidays.csv': `date,description\n${dates.map((d) => `${d},"x"`).join('\n')}\n` });

describe('checkHolidays', () => {
  it('is fine in October with rows to year end', () => {
    expect(checkHolidays('2026-10-07', holidays('2026-12-25')).ok).toBe(true);
  });
  it('is a problem from 1 Dec with no next-year row', () => {
    const r = checkHolidays('2026-12-01', holidays('2026-12-25'));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('2027');
  });
  it('is fine from 1 Dec once next year is present', () => {
    expect(checkHolidays('2026-12-01', holidays('2026-12-25', '2027-01-26')).ok).toBe(true);
  });
  it('is a problem when the last row is in the past', () => {
    expect(checkHolidays('2027-01-02', holidays('2026-12-25')).ok).toBe(false);
  });
  it('is a problem when empty', () => {
    expect(checkHolidays('2026-10-07', holidays()).ok).toBe(false);
  });
});

const rbi = (...dates: string[]) =>
  fake({
    '015_a.sql': `INSERT INTO event_calendar VALUES\n${dates
      .map((d) => `  ('${d}', 'RBI_POLICY', 'x')`)
      .join(',\n')};`,
    '016_b.sql': "INSERT INTO event_calendar VALUES ('2030-01-01', 'BUDGET', 'x');",
  });

describe('checkRbiDates', () => {
  it('passes with 45+ days of runway and ignores other event types', () => {
    expect(checkRbiDates('2026-10-07', rbi('2027-02-05')).ok).toBe(true);
  });
  it('fails under 45 days ahead', () => {
    const r = checkRbiDates('2026-12-30', rbi('2027-02-05'));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('2027-02-05');
  });
  it('fails when no rows exist', () => {
    expect(checkRbiDates('2026-10-07', rbi()).ok).toBe(false);
  });
});

describe('checkMargin', () => {
  const margin = (month: string) =>
    fake({
      'margin.csv': `underlying,strategy_type,month,margin_inr\nNIFTY,short-straddle,${month},140000\n`,
    });
  it('fails when the latest month is before this one', () => {
    expect(checkMargin('2026-10-01', margin('2026-08')).ok).toBe(false);
  });
  it('passes when the current month is present', () => {
    expect(checkMargin('2026-10-01', margin('2026-10')).ok).toBe(true);
  });
});

describe('checkCalendars', () => {
  it('fails if either part fails', () => {
    const readers = fake({
      'holidays.csv': 'date,description\n2026-12-25,"x"\n',
      '015_a.sql': "('2027-02-05', 'RBI_POLICY', 'x')",
    });
    expect(checkCalendars('2026-12-01', readers).ok).toBe(false);
    expect(checkCalendars('2026-10-07', readers).ok).toBe(true);
  });
});

describe('firstTradingDayOfMonth', () => {
  it('picks Monday when the 1st is a weekend', () => {
    expect(firstTradingDayOfMonth('2026-11-02')).toBe(true); // 1 Nov 2026 is a Sunday
    expect(firstTradingDayOfMonth('2026-11-03')).toBe(false);
  });
  it('picks the 1st when it is a trading day', () => {
    expect(firstTradingDayOfMonth('2026-10-01')).toBe(true);
  });
});

describe('real reference data', () => {
  it('is readable and today passes the repo checks it should', () => {
    const readers = diskReaders(resolve(import.meta.dirname, '../../../..'));
    expect(checkHolidays('2026-10-07', readers).ok).toBe(true);
    expect(checkRbiDates('2026-10-07', readers).ok).toBe(true);
  });
});

describe('checkBlockedDates (Y3)', () => {
  const list = (...d: string[]) => JSON.stringify(d);
  it('passes when unset or empty', () => {
    expect(checkBlockedDates('2026-12-01', undefined).ok).toBe(true);
    expect(checkBlockedDates('2026-12-01', '').ok).toBe(true);
    expect(checkBlockedDates('2026-12-01', '[]').ok).toBe(true);
  });
  it('fails on a list the engine would ignore', () => {
    expect(checkBlockedDates('2026-10-28', '2026-10-29').ok).toBe(false);
    expect(checkBlockedDates('2026-10-28', '{"a":1}').detail).toContain('not a JSON array');
    const r = checkBlockedDates('2026-10-28', '["2026-10-29", "29/10/2026"]');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('"29/10/2026"');
  });
  it('fails on impossible days of the right shape', () => {
    for (const day of ['2027-13-45', '2027-02-30', '2027-00-10']) {
      const r = checkBlockedDates('2026-10-28', list('2026-11-26', day));
      expect(r.ok).toBe(false);
      expect(r.detail).toContain(day);
    }
  });
  it('notes upcoming closed days without failing (a weekend Budget session is legitimate)', () => {
    const r = checkBlockedDates(
      '2026-10-28',
      list('2026-10-02', '2026-11-10', '2026-11-14', '2026-11-26'),
    );
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('closed: 2026-11-10, 2026-11-14');
    expect(r.detail).not.toContain('2026-10-02');
  });
  it('is quiet before December and asks for next year from 1 Dec', () => {
    const thisYear = list('2026-11-26', '2026-12-31');
    expect(checkBlockedDates('2026-11-30', thisYear).ok).toBe(true);
    const dec = checkBlockedDates('2026-12-01', thisYear);
    expect(dec.ok).toBe(false);
    expect(dec.detail).toContain('no 2027 days');
    expect(checkBlockedDates('2026-12-01', list('2026-12-31', '2027-01-28')).ok).toBe(true);
  });
  it('fails when every day is past', () => {
    expect(checkBlockedDates('2027-01-04', list('2026-12-31')).detail).toContain('in the past');
  });
  it('passes on the .env.example list until December', () => {
    const example = readFileSync(resolve(import.meta.dirname, '../../../../.env.example'), 'utf8');
    const raw = /^BLOCKED_DATES=(.*)$/m.exec(example)?.[1];
    expect(raw).toBeDefined();
    expect(checkBlockedDates('2026-10-28', raw).ok).toBe(true);
    expect(checkBlockedDates('2026-12-01', raw).ok).toBe(false);
  });
});

describe('fix hints', () => {
  it('name the real catalog tables, which `tdata reference sql` needs', async () => {
    const { jobs } = await import('../checks/calendar.js');
    const hints = jobs.map((j) => j.fixHint).join('\n');
    expect(hints).toContain('INSERT INTO ref_holidays');
    expect(hints).toContain('INSERT INTO ref_margins ');
    expect(hints).not.toMatch(/ref_margin\b/);
  });
});
