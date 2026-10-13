import { describe, expect, it } from 'vitest';

import type { MatrixResponse, MatrixResult } from '../../types/rotationMatrix';
import {
  type Sessions,
  addDays,
  answersSelection,
  latestNote,
  parseSessions,
  probeParams,
  resolveSelection,
  selectionParams,
  thinNote,
  todayIst,
  typeLabel,
  typeRows,
} from '../heatmapTimeByTypeView';

const NONE = { preset: null, day: null, from: null, to: null };
const SESSIONS: Sessions = {
  days: ['2026-10-01', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'],
  first: '2024-10-09',
  last: '2026-10-09',
};

describe('resolveSelection', () => {
  it('is null until the latest scored day is known', () => {
    expect(resolveSelection(NONE, { days: [], first: null, last: null })).toBeNull();
  });

  it('defaults to the latest scored session as one day with no thin flag', () => {
    const s = resolveSelection(NONE, SESSIONS);
    expect(s).toMatchObject({
      mode: 'latest',
      period: 'custom',
      from: '2026-10-09',
      to: '2026-10-09',
      single: true,
      minN: 1,
    });
  });

  it('builds a single-day request: custom, from = to, min_n = 1', () => {
    const s = resolveSelection({ ...NONE, day: '2026-10-07' }, SESSIONS);
    expect(s).toMatchObject({ mode: 'day', from: '2026-10-07', to: '2026-10-07', minN: 1 });
    expect(selectionParams(s as NonNullable<typeof s>)).toEqual({
      view: 'family_slot',
      period: 'custom',
      from: '2026-10-07',
      to: '2026-10-07',
      metric: 'avg',
      min_n: '1',
    });
  });

  it('takes the last N scored sessions and keeps the default minimum for a range', () => {
    const s = resolveSelection({ ...NONE, preset: 'last5' }, SESSIONS);
    expect(s).toMatchObject({ mode: 'last5', from: '2026-10-05', to: '2026-10-09', minN: 20 });
    // the default minimum is not sent: the API's own default applies
    expect(selectionParams(s as NonNullable<typeof s>)).not.toHaveProperty('min_n');
  });

  it('uses fewer days when the store has fewer than N', () => {
    const s = resolveSelection({ ...NONE, preset: 'last63' }, SESSIONS);
    expect(s?.from).toBe('2026-10-01');
  });

  it('sends a named period as the period alone', () => {
    const s = resolveSelection({ ...NONE, preset: 'P1' }, SESSIONS);
    expect(selectionParams(s as NonNullable<typeof s>)).toEqual({
      view: 'family_slot',
      period: 'P1',
      metric: 'avg',
    });
  });

  it('lets a preset win over a day, then a day over a range', () => {
    expect(
      resolveSelection({ preset: 'P2', day: '2026-10-07', from: null, to: null }, SESSIONS)?.mode,
    ).toBe('P2');
    expect(
      resolveSelection({ preset: null, day: '2026-10-07', from: '2026-10-01', to: null }, SESSIONS)
        ?.mode,
    ).toBe('day');
  });

  it('fills an open end of a range and swaps a reversed one', () => {
    expect(resolveSelection({ ...NONE, from: '2026-10-05' }, SESSIONS)).toMatchObject({
      mode: 'range',
      from: '2026-10-05',
      to: '2026-10-09',
      minN: 20,
    });
    expect(resolveSelection({ ...NONE, to: '2026-10-05' }, SESSIONS)).toMatchObject({
      from: '2024-10-09',
      to: '2026-10-05',
    });
    expect(
      resolveSelection({ ...NONE, from: '2026-10-08', to: '2026-10-06' }, SESSIONS),
    ).toMatchObject({ from: '2026-10-06', to: '2026-10-08' });
  });

  it('treats a range of one day as a single day', () => {
    const s = resolveSelection({ ...NONE, from: '2026-10-06', to: '2026-10-06' }, SESSIONS);
    expect(s).toMatchObject({ mode: 'range', single: true, minN: 1 });
  });

  it('ignores a malformed day and falls back to the latest', () => {
    expect(resolveSelection({ ...NONE, day: 'tomorrow' }, SESSIONS)?.mode).toBe('latest');
  });
});

describe('sessions probe', () => {
  const probe = {
    available: true,
    rows: [
      { key: '2026-10-08', label: '2026-10-08 Thu', date: '2026-10-08' },
      { key: '2026-10-07', label: '2026-10-07 Wed', date: '2026-10-07' },
      { key: 'x', label: 'x' },
    ],
    meta: { store: { first: '2024-10-09', last: '2026-10-08' } },
  } as unknown as MatrixResult;

  it('reads the dates in order and the store latest', () => {
    expect(parseSessions(probe)).toEqual({
      days: ['2026-10-07', '2026-10-08'],
      first: '2024-10-09',
      last: '2026-10-08',
    });
  });

  it('is empty before the answer and keeps the store span when nothing is available', () => {
    expect(parseSessions(null)).toEqual({ days: [], first: null, last: null });
    const none = {
      available: false,
      reason: 'x',
      meta: { store: { first: null, last: null } },
    } as unknown as MatrixResult;
    expect(parseSessions(none).last).toBeNull();
  });

  it('asks for the date view of one kind from about 130 days back', () => {
    expect(probeParams('2026-10-12')).toEqual({
      view: 'date_slot',
      index: 'NIFTY',
      family: 'wide',
      period: 'custom',
      from: addDays('2026-10-12', -130),
      metric: 'avg',
    });
  });

  it('reads today on the Indian calendar', () => {
    // 2026-10-11 20:00 UTC is already 2026-10-12 in Mumbai
    expect(todayIst(Date.UTC(2026, 9, 11, 20, 0, 0))).toBe('2026-10-12');
    expect(todayIst(Date.UTC(2026, 9, 11, 10, 0, 0))).toBe('2026-10-11');
  });
});

describe('typeLabel', () => {
  it('writes the owner idiom from the key and the strike in the label', () => {
    expect(typeLabel({ key: 'N:wide', label: 'NIFTY Widesl OTM1' })).toBe('N_wide (OTM1)');
    expect(typeLabel({ key: 'S:wide', label: 'SENSEX Widesl OTM2' })).toBe('S_wide (OTM2)');
    expect(typeLabel({ key: 'N:dir', label: 'NIFTY Dir ATM' })).toBe('N_dir (ATM)');
    expect(typeLabel({ key: 'N:p80', label: 'NIFTY Widesl, premium 80' })).toBe('N_p80');
    expect(typeLabel({ key: 'S:p250', label: 'SENSEX Widesl, premium 250' })).toBe('S_p250');
    expect(typeLabel({ key: 'N:ditm1', label: 'NIFTY Dir ITM1' })).toBe('N_ditm1');
    expect(typeLabel({ key: 'N:buy', label: 'NIFTY Buy ATM' })).toBe('N_buy');
  });

  it('does not invent a strike the file did not give', () => {
    expect(typeLabel({ key: 'N:wide', label: 'NIFTY Widesl' })).toBe('N_wide');
  });

  it('keeps a label it cannot parse', () => {
    expect(typeLabel({ key: 'odd', label: 'Odd one' })).toBe('Odd one');
  });

  it('renames rows without touching their keys', () => {
    const rows = typeRows([{ key: 'N:wide', label: 'NIFTY Widesl OTM1', index: 'NIFTY' }]);
    expect(rows[0]).toMatchObject({ key: 'N:wide', label: 'N_wide (OTM1)', index: 'NIFTY' });
  });
});

describe('notes', () => {
  const latest = resolveSelection(NONE, SESSIONS) as NonNullable<
    ReturnType<typeof resolveSelection>
  >;
  it('says which day is shown when today is not scored', () => {
    expect(latestNote(latest, '2026-10-12')).toMatch(/latest scored session, 09 Oct 2026/);
    expect(latestNote(latest, '2026-10-09')).toBeNull();
  });

  it('flags a short range as thin but not a single day', () => {
    const five = resolveSelection({ ...NONE, preset: 'last5' }, SESSIONS) as NonNullable<
      ReturnType<typeof resolveSelection>
    >;
    expect(thinNote(five, 4)).toMatch(/flagged thin/);
    expect(thinNote(five, 25)).toBeNull();
    expect(thinNote(latest, 1)).toBeNull();
  });
});

describe('answersSelection', () => {
  const answer = (id: string, from: string | null, to: string | null) =>
    ({ periods: [{ id, from, to }] }) as unknown as MatrixResponse;

  it('matches a custom answer on its dates only', () => {
    const sel = resolveSelection({ ...NONE, day: '2026-10-07' }, SESSIONS) as NonNullable<
      ReturnType<typeof resolveSelection>
    >;
    expect(answersSelection(answer('custom', '2026-10-07', '2026-10-07'), sel)).toBe(true);
    expect(answersSelection(answer('custom', '2026-10-09', '2026-10-09'), sel)).toBe(false);
    expect(answersSelection(answer('P1', null, null), sel)).toBe(false);
  });

  it('matches a named period on its id', () => {
    const sel = resolveSelection({ ...NONE, preset: 'P2' }, SESSIONS) as NonNullable<
      ReturnType<typeof resolveSelection>
    >;
    expect(answersSelection(answer('P2', '2025-01-10', '2025-08-29'), sel)).toBe(true);
    expect(answersSelection(answer('P1', '2025-12-03', '2026-10-08'), sel)).toBe(false);
  });
});
