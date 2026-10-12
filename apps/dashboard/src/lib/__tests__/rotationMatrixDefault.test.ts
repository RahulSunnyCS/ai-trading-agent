import { describe, expect, it } from 'vitest';

import { addDays } from '../regimeTags';
import {
  FALLBACK_NOTE,
  changedCount,
  effectiveFilters,
  latestDayNote,
  parseSessions,
  presetPatch,
  probeParams,
  settingsSummary,
  todayIst,
  usesTodayDefault,
} from '../rotationMatrixDefault';
import { DEFAULT_FILTERS, type MatrixFilters } from '../rotationMatrixView';

const none = { period: false, minN: false };
const sessions = {
  days: ['2026-10-01', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'],
  last: '2026-10-09',
};

describe('effectiveFilters', () => {
  it('uses the latest scored day as one session when the URL names no period', () => {
    const f = effectiveFilters(DEFAULT_FILTERS, none, '2026-10-09');
    expect(f).toMatchObject({
      period: 'custom',
      from: '2026-10-09',
      to: '2026-10-09',
      compare: false,
      minN: 1,
      view: 'family_slot',
      metric: 'avg',
    });
  });

  it('waits (keeps the filters) until the latest day is known', () => {
    expect(effectiveFilters(DEFAULT_FILTERS, none, null)).toEqual(DEFAULT_FILTERS);
  });

  it('leaves a period named in the URL alone', () => {
    const f: MatrixFilters = { ...DEFAULT_FILTERS, period: 'P2' };
    expect(effectiveFilters(f, { period: true, minN: false }, '2026-10-09')).toEqual(f);
  });

  it('treats P1 and P2 side by side as a named period', () => {
    const f: MatrixFilters = { ...DEFAULT_FILTERS, compare: true };
    const out = effectiveFilters(f, { period: true, minN: false }, '2026-10-09');
    expect(out.compare).toBe(true);
    expect(out.period).toBe('P1');
    expect(out.minN).toBe(DEFAULT_FILTERS.minN);
  });

  it("keeps the owner's minimum sessions when the URL names one", () => {
    const out = effectiveFilters(
      { ...DEFAULT_FILTERS, minN: 7 },
      { period: false, minN: true },
      '2026-10-09',
    );
    expect(out.minN).toBe(7);
  });

  it('asks for min_n=1 for an explicit one-day custom range, not for a longer one', () => {
    const day: MatrixFilters = {
      ...DEFAULT_FILTERS,
      period: 'custom',
      from: '2026-10-07',
      to: '2026-10-07',
    };
    const ex = { period: true, minN: false };
    expect(effectiveFilters(day, ex, '2026-10-09').minN).toBe(1);
    expect(effectiveFilters({ ...day, to: '2026-10-08' }, ex, '2026-10-09').minN).toBe(
      DEFAULT_FILTERS.minN,
    );
  });

  it('does not apply to the pulse, which is as of a date', () => {
    const f: MatrixFilters = { ...DEFAULT_FILTERS, view: 'pulse' };
    expect(usesTodayDefault(f, none)).toBe(false);
    expect(effectiveFilters(f, none, '2026-10-09')).toEqual(f);
  });
});

describe('parseSessions', () => {
  it('takes the newest stored date of the probe', () => {
    const result = {
      available: true,
      rows: [{ date: '2026-10-08' }, { date: '2026-10-05' }, { key: 'x' }],
      meta: { store: { first: '2024-10-09', last: '2026-10-09' } },
    };
    expect(parseSessions(result as never)).toEqual({
      days: ['2026-10-05', '2026-10-08'],
      last: '2026-10-08',
    });
  });

  it("falls back to the store's last day, and to nothing for an empty store", () => {
    const empty = { available: true, rows: [], meta: { store: { last: '2026-10-09' } } };
    expect(parseSessions(empty as never).last).toBe('2026-10-09');
    const unavailable = { available: false, reason: 'x', meta: { store: { last: null } } };
    expect(parseSessions(unavailable as never)).toEqual({ days: [], last: null });
    expect(parseSessions(null).last).toBeNull();
  });
});

describe('presets', () => {
  it('counts the last N scored days back from the newest', () => {
    expect(presetPatch('last5', sessions)).toEqual({
      period: 'custom',
      compare: false,
      from: '2026-10-05',
      to: '2026-10-09',
    });
  });

  it('uses the first stored day when fewer than N exist', () => {
    expect(presetPatch('last21', sessions)).toMatchObject({ from: '2026-10-01' });
  });

  it('P1, P2 and Forward name the period; Latest day clears it', () => {
    expect(presetPatch('P2', sessions)).toMatchObject({ period: 'P2', from: '', to: '' });
    expect(presetPatch('forward', sessions)).toMatchObject({ period: 'forward' });
    expect(presetPatch('latest', sessions)).toBeNull();
  });
});

describe('words', () => {
  it('says which day it shows when that is not today, and nothing when it is', () => {
    expect(latestDayNote('2026-10-09', '2026-10-12')).toContain('09 Oct 2026');
    expect(latestDayNote('2026-10-09', '2026-10-12')).toContain('12 Oct 2026');
    expect(latestDayNote('2026-10-12', '2026-10-12')).toBeNull();
    expect(FALLBACK_NOTE).toContain('P1');
  });

  it('summarises the active settings in a line', () => {
    const today = effectiveFilters(DEFAULT_FILTERS, none, '2026-10-12');
    expect(settingsSummary(today, { today: '2026-10-12' })).toBe(
      'Today · 12 Oct 2026 · Both indices · All families',
    );
    expect(
      settingsSummary(
        {
          ...today,
          from: '2026-10-09',
          to: '2026-10-09',
          index: 'NIFTY',
          list: 'A',
          weekday: 'Fri',
        },
        { today: '2026-10-12' },
      ),
    ).toBe('Session of 09 Oct 2026 · NIFTY · All families · Fri · Steady picks');
    expect(
      settingsSummary({ ...DEFAULT_FILTERS, period: 'P1', compare: true }, { today: 'x' }),
    ).toContain('P1 and P2');
  });

  it('counts changed settings', () => {
    expect(changedCount(DEFAULT_FILTERS, none)).toBe(0);
    expect(
      changedCount(
        { ...DEFAULT_FILTERS, index: 'NIFTY', slot: '0917' },
        { period: true, minN: false },
      ),
    ).toBe(3);
  });
});

describe('dates', () => {
  it("reads the exchange's calendar and steps days", () => {
    expect(todayIst(Date.UTC(2026, 9, 12, 20, 0))).toBe('2026-10-13');
    expect(addDays('2026-10-12', -130)).toBe('2026-06-04');
    expect(probeParams('2026-10-12')).toMatchObject({
      view: 'date_slot',
      period: 'custom',
      from: '2026-06-04',
    });
  });
});
