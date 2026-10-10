import { describe, expect, it } from 'vitest';

import {
  ALL_FROM,
  NOTE_MAX,
  addDays,
  applyFilter,
  counterParts,
  defaultWindow,
  emptyHeadline,
  familyShort,
  focusStopped,
  initialMonth,
  isFlagged,
  monthGrid,
  monthOf,
  monthTitle,
  pickLabel,
  placementProblem,
  placementTally,
  rowFlags,
  shadeClass,
  shadeScale,
  shadeStep,
  shiftMonth,
  windowRange,
} from '../rotationDailyLogView';
import { COUNTERS, ROWS, log, pick, placement, row } from './rotationDailyLogFixture';

const byDay = (day: string) => {
  const r = ROWS.find((x) => x.day === day);
  if (!r) throw new Error(day);
  return r;
};

describe('window', () => {
  it('asks for the whole short journal, and a bounded slice of the long history', () => {
    expect(windowRange('all', '2026-10-19', 'recorded')).toEqual({
      from: undefined,
      to: undefined,
    });
    expect(windowRange('all', '2026-10-19', 'reconstructed').from).toBe(ALL_FROM);
    expect(defaultWindow('recorded')).toBe('all');
    expect(defaultWindow('reconstructed')).toBe('126');
  });

  it('counts a trading-day window back in calendar days', () => {
    // 63 trading days at 5 a week is 12.6 weeks: 89 calendar days back
    expect(windowRange('63', '2026-10-19', 'recorded').from).toBe('2026-07-22');
    expect(addDays('2026-03-01', 1)).toBe('2026-03-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('naming', () => {
  it('names the families as a reader would', () => {
    expect(familyShort('wide')).toBe('Widesl OTM1');
    expect(familyShort('p80')).toBe('Widesl p80');
    expect(familyShort('dir')).toBe('Dir ATM');
    expect(familyShort('ditm1')).toBe('Dir ITM1');
    expect(familyShort('buy')).toBe('Buy');
    expect(familyShort(null)).toBe('—');
  });

  it('labels a pick from the parts the API parsed out of its name', () => {
    expect(pickLabel(pick('S_p250_1302', 1))).toBe('SENSEX Widesl p250 13:02');
    expect(pickLabel({ ...pick('N_wide_0917', 1), index: null })).toBe('N_wide_0917');
  });
});

describe('flags', () => {
  it('flags a late entry, a fallback VIX and a stop, each with its reason', () => {
    const late = rowFlags(byDay('2026-10-14'));
    expect(late.map((f) => f.id)).toContain('late');
    expect(late.find((f) => f.id === 'late')?.title).toMatch(/not a forward entry/);

    const angel = rowFlags(byDay('2026-10-16'));
    expect(angel.map((f) => f.id)).toEqual(expect.arrayContaining(['vix_angelone', 'stop']));

    // the minimum and a Buy are markers on a list's figure, not badges on the day
    const mixed = rowFlags(byDay('2026-10-13')).map((f) => f.id);
    expect(mixed).not.toContain('override');
    expect(mixed).not.toContain('buy');
  });

  it('says a reconstructed day is reconstructed, and does not flag its VIX source', () => {
    const r = row('2026-10-01', 'Thu', byDay('2026-10-12').lists, {
      source: 'reconstructed',
      vix: { open: 14, band: '13-15', source: 'history' },
      dte: { NIFTY: '1', SENSEX: '2', source: 'history' },
      recorded: null,
    });
    const ids = rowFlags(r).map((f) => f.id);
    expect(ids).toContain('reconstructed');
    expect(ids.some((i) => i.startsWith('vix'))).toBe(false);
  });

  it('flags a calendar-sourced days to expiry and a missing VIX open', () => {
    const r = row('2026-10-12', 'Mon', byDay('2026-10-12').lists, {
      vix: { open: null, band: 'unknown', source: 'given' },
      dte: { NIFTY: '1', SENSEX: '2', source: 'calendar' },
    });
    expect(rowFlags(r).map((f) => f.id)).toEqual(
      expect.arrayContaining(['vix_missing', 'dte_calendar']),
    );
  });

  it('outlines a day whose record is not the ordinary one, not a day whose picks stopped out', () => {
    expect(isFlagged(byDay('2026-10-14'))).toBe(true); // late
    expect(isFlagged(byDay('2026-10-15'))).toBe(true); // no entry
    expect(isFlagged(byDay('2026-10-12'))).toBe(false);
    expect(isFlagged(byDay('2026-10-16'))).toBe(false); // a stop (and an Angel One VIX) is not a fault
    expect(isFlagged(byDay('2026-10-19'))).toBe(false); // waiting is not a fault
    expect(isFlagged(null)).toBe(false);
    const given = row('2026-10-12', 'Mon', byDay('2026-10-12').lists, {
      vix: { open: 14, band: '13-15', source: 'given' },
    });
    expect(isFlagged(given)).toBe(true);
  });

  it('notes a stop on the focus list only', () => {
    expect(focusStopped(byDay('2026-10-16'), 'A')).toBe(true);
    expect(focusStopped(byDay('2026-10-12'), 'A')).toBe(false);
    expect(focusStopped(byDay('2026-10-15'), 'A')).toBe(false);
    expect(focusStopped(null, 'A')).toBe(false);
  });
});

describe('browsing filters', () => {
  it('keeps every day on All and drops the day with no entry from the others', () => {
    expect(applyFilter(ROWS, 'all', 'A')).toHaveLength(ROWS.length);
    expect(applyFilter(ROWS, 'differ', 'A').some((r) => r.status === 'not_recorded')).toBe(false);
  });

  it('Losing is the focus list losing, and an unscored day is not a loss', () => {
    const losing = applyFilter(ROWS, 'losing', 'A').map((r) => r.day);
    expect(losing).toEqual(['2026-10-16']);
    expect(applyFilter(ROWS, 'losing', 'A').every((r) => r.lists.A?.per_lot_day !== null)).toBe(
      true,
    );
  });

  it('Stops is any pick of any list stopped; Lists disagree is not all identical', () => {
    expect(applyFilter(ROWS, 'stops', 'A').map((r) => r.day)).toEqual(['2026-10-16']);
    expect(applyFilter(ROWS, 'differ', 'A').map((r) => r.day)).toEqual(['2026-10-13']);
  });
});

describe('calendar', () => {
  const holidays = [{ day: '2026-10-20', name: 'Dussehra' }];

  it('lays October 2026 out in Monday to Friday weeks with the neighbours outside', () => {
    const weeks = monthGrid({ year: 2026, month: 10 }, ROWS, holidays, 'A', '2026-10-19');
    expect(weeks[0]?.map((c) => c.date)).toEqual([28, 29, 30, 1, 2]); // Sep 28 .. Oct 2
    expect(weeks[0]?.map((c) => c.kind)).toEqual(['outside', 'outside', 'outside', 'none', 'none']);
    expect(weeks.every((w) => w.length === 5)).toBe(true);
    expect(weeks.length).toBe(5);
  });

  it('marks each kind of day: a figure, late, no entry, holiday, not yet, nothing here', () => {
    const cells = monthGrid({ year: 2026, month: 10 }, ROWS, holidays, 'A', '2026-10-19')
      .flat()
      .filter((c) => c.kind !== 'outside');
    const kind = (d: string) => cells.find((c) => c.day === d)?.kind;
    expect(kind('2026-10-12')).toBe('scored');
    expect(kind('2026-10-14')).toBe('late');
    expect(kind('2026-10-15')).toBe('not_recorded');
    expect(kind('2026-10-19')).toBe('waiting');
    expect(kind('2026-10-20')).toBe('holiday');
    expect(kind('2026-10-21')).toBe('future');
    expect(kind('2026-10-05')).toBe('none');
  });

  it('gives a day its focus list value and none where the list has no figure', () => {
    const cells = monthGrid({ year: 2026, month: 10 }, ROWS, holidays, 'REF', '2026-10-19')
      .flat()
      .filter((c) => c.kind !== 'outside');
    expect(cells.find((c) => c.day === '2026-10-13')?.value).toBeCloseTo((300 - 300 - 450) / 3, 6);
    expect(cells.find((c) => c.day === '2026-10-15')?.value).toBeNull();
    expect(cells.find((c) => c.day === '2026-10-19')?.value).toBeNull();
  });

  it('steps between months across a year end and opens on the latest day with a row', () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(monthTitle({ year: 2026, month: 10 })).toBe('October 2026');
    expect(initialMonth(ROWS, '2026-11-02')).toEqual({ year: 2026, month: 10 });
    expect(initialMonth([], '2026-11-02')).toEqual(monthOf('2026-11-02'));
  });
});

describe('shading', () => {
  it('shades by size against the largest day in view and never shades a missing or flat day', () => {
    expect(shadeStep(null, 1000)).toBe(0);
    expect(shadeStep(0, 1000)).toBe(0);
    expect(shadeStep(100, 1000)).toBe(1);
    expect(shadeStep(-500, 1000)).toBe(2);
    expect(shadeStep(900, 1000)).toBe(3);
    expect(shadeStep(5, 0)).toBe(0);
  });

  it('uses profit and loss token classes only', () => {
    expect(shadeClass(900, 1000)).toBe('bg-positive/30');
    expect(shadeClass(-900, 1000)).toBe('bg-negative/30');
    expect(shadeClass(null, 1000)).toBe('');
  });

  it('takes the scale from scored days only', () => {
    const scale = shadeScale(ROWS, 'A');
    expect(scale).toBeGreaterThan(0);
    expect(shadeScale([byDay('2026-10-19')], 'A')).toBe(0);
  });
});

describe('placement', () => {
  it('counts how many of the day lists are marked and how', () => {
    const r = {
      ...byDay('2026-10-12'),
      placement: {
        A: placement('2026-10-12', 'A', 'placed'),
        B: placement('2026-10-12', 'B', 'changed', 'dropped the Buy'),
        C: placement('2026-10-12', 'C', 'not_placed', 'AlgoTest down'),
      },
    };
    expect(placementTally(r)).toEqual({ marked: 3, of: 4, placed: 1, changed: 1, notPlaced: 1 });
    expect(placementTally(byDay('2026-10-12'))).toMatchObject({ marked: 0, of: 4 });
  });

  it('refuses an unchosen status, a changed with no note and a long note', () => {
    expect(placementProblem('', '')).toMatch(/Choose/);
    expect(placementProblem('changed', '   ')).toMatch(/what was changed/);
    expect(placementProblem('placed', 'x'.repeat(NOTE_MAX + 1))).toMatch(/at most 300/);
    expect(placementProblem('placed', '')).toBeNull();
    expect(placementProblem('changed', 'dropped the Buy leg')).toBeNull();
    expect(placementProblem('not_placed', 'x'.repeat(NOTE_MAX))).toBeNull();
  });
});

describe('counters and the empty state', () => {
  it('lists the structural counters per list and says what they are over', () => {
    const parts = counterParts(COUNTERS, 'recorded');
    const get = (id: string) => parts.find((p) => p.id === id);
    expect(get('days')?.value).toBe('5');
    expect(get('late')?.value).toBe('1');
    expect(get('not_recorded')?.value).toBe('1');
    expect(get('buy')?.value).toBe('A 1/5 · B 1/5 · C 0/5 · REF 0/5');
    expect(get('override')?.value).toBe('A 0/5 · B 0/5 · C 1/5 · REF 0/5');
    expect(get('identical')?.value).toBe('3/5');
    expect(get('stops')?.value).toBe('1/5');
  });

  it('leaves late and not-recorded out of a reconstructed footer, which has neither', () => {
    const ids = counterParts(COUNTERS, 'reconstructed').map((p) => p.id);
    expect(ids).not.toContain('late');
    expect(ids).not.toContain('not_recorded');
  });

  it('names the first entry before it exists, and the miss after it was due', () => {
    expect(emptyHeadline(log({ today: '2026-10-10' }))).toBe(
      'First entry Monday 12 October, 09:16',
    );
    expect(emptyHeadline(log({ today: '2026-10-13' }))).toMatch(/due Monday 12 October, 09:16/);
  });
});
