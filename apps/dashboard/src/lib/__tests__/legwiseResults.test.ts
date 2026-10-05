import { describe, expect, it } from 'vitest';

import {
  type ComparisonRow,
  DEFAULT_SORT,
  ariaSort,
  comparisonRows,
  daysOf,
  dteText,
  filterByRange,
  hasRange,
  nextSort,
  segmentNames,
  sortComparison,
  sparkline,
  strategiesFor,
  underlyingsOf,
} from '../legwiseResults';

const day = (d: string, net = 0, worst_mtm = 0) => ({ day: d, net, worst_mtm });

describe('filterByRange', () => {
  const rows = [day('2026-09-23'), day('2026-09-24'), day('2026-09-25'), day('2026-10-01')];

  it('returns everything for an empty range', () => {
    expect(filterByRange(rows, {})).toHaveLength(4);
    expect(filterByRange(rows, { from: '', to: '' })).toHaveLength(4);
    expect(hasRange({ from: '', to: '' })).toBe(false);
  });

  it('is inclusive at both ends', () => {
    const out = filterByRange(rows, { from: '2026-09-24', to: '2026-09-25' });
    expect(out.map((r) => r.day)).toEqual(['2026-09-24', '2026-09-25']);
  });

  it('supports an open end', () => {
    expect(filterByRange(rows, { from: '2026-09-25' }).map((r) => r.day)).toEqual([
      '2026-09-25',
      '2026-10-01',
    ]);
    expect(filterByRange(rows, { to: '2026-09-23' }).map((r) => r.day)).toEqual(['2026-09-23']);
    expect(hasRange({ to: '2026-09-23' })).toBe(true);
  });

  it('reads a backwards range as the same span', () => {
    const out = filterByRange(rows, { from: '2026-09-25', to: '2026-09-24' });
    expect(out.map((r) => r.day)).toEqual(['2026-09-24', '2026-09-25']);
  });
});

describe('daysOf', () => {
  it('is distinct and newest first', () => {
    expect(daysOf([day('2026-09-23'), day('2026-10-01'), day('2026-09-23')])).toEqual([
      '2026-10-01',
      '2026-09-23',
    ]);
  });
});

describe('underlyings', () => {
  const byId = new Map([
    ['a', 'NIFTY'],
    ['b', 'SENSEX'],
    ['c', 'NIFTY'],
    ['d', 'BANKNIFTY'],
  ]);

  it('lists the underlyings with the most strategies first, ties by name', () => {
    expect(underlyingsOf(['a', 'b', 'c', 'd', 'unknown'], byId)).toEqual([
      'NIFTY',
      'BANKNIFTY',
      'SENSEX',
    ]);
    expect(underlyingsOf(['unknown'], byId)).toEqual([]);
  });

  it('filters strategies to an underlying and keeps unknown ones visible', () => {
    const all = ['a', 'b', 'c', 'x'].map((id) => ({ id }));
    expect(strategiesFor(all, byId, 'NIFTY').map((s) => s.id)).toEqual(['a', 'c', 'x']);
    expect(strategiesFor(all, byId, 'SENSEX').map((s) => s.id)).toEqual(['b', 'x']);
    expect(strategiesFor(all, byId, null)).toHaveLength(4);
  });
});

describe('comparisonRows', () => {
  it('computes per-lot stats, worst MTM and a stable colour index', () => {
    const rows = comparisonRows([
      {
        id: 'one',
        name: 'one',
        sha: 'abc',
        lots: 2,
        days: [day('2026-09-24', -400, -1000), day('2026-09-23', 1000, -200)],
      },
      { id: 'none', name: 'none', sha: 'def', lots: 1, days: [] },
    ]);
    expect(rows[0]?.colorIndex).toBe(0);
    expect(rows[0]?.stats.total).toBe(300);
    expect(rows[0]?.stats.days).toBe(2);
    expect(rows[0]?.stats.cumulative.map((p) => p.value)).toEqual([500, 300]);
    expect(rows[0]?.worstMtm).toBe(-500);
    expect(rows[1]?.colorIndex).toBe(1);
    expect(rows[1]?.worstMtm).toBeNull();
  });
});

describe('sortComparison', () => {
  const rows = comparisonRows([
    { id: 'b', name: 'beta', sha: '1', lots: 1, days: [day('2026-09-23', 100, -50)] },
    { id: 'e', name: 'empty', sha: '2', lots: 1, days: [] },
    {
      id: 'a',
      name: 'alpha',
      sha: '3',
      lots: 1,
      days: [day('2026-09-23', 500, -900), day('2026-09-24', -100, -300)],
    },
    { id: 'g', name: 'gamma', sha: '4', lots: 1, days: [day('2026-09-23', -250, -400)] },
  ]);
  const ids = (xs: ComparisonRow[]) => xs.map((r) => r.id);

  it('ranks by Net / lot, best first, by default', () => {
    expect(DEFAULT_SORT).toEqual({ key: 'total', dir: 'desc' });
    expect(ids(sortComparison(rows, DEFAULT_SORT))).toEqual(['a', 'b', 'g', 'e']);
  });

  it('keeps rows with no value last in both directions', () => {
    expect(ids(sortComparison(rows, { key: 'total', dir: 'asc' }))).toEqual(['g', 'b', 'a', 'e']);
    // Profit factor is null without a losing day (beta) and with no days (empty).
    expect(ids(sortComparison(rows, { key: 'profitFactor', dir: 'desc' }))).toEqual([
      'a',
      'g',
      'b',
      'e',
    ]);
    expect(ids(sortComparison(rows, { key: 'profitFactor', dir: 'asc' }))).toEqual([
      'g',
      'a',
      'b',
      'e',
    ]);
  });

  it('sorts by name, days and worst MTM', () => {
    expect(ids(sortComparison(rows, { key: 'name', dir: 'asc' }))).toEqual(['a', 'b', 'e', 'g']);
    expect(ids(sortComparison(rows, { key: 'days', dir: 'desc' }))).toEqual(['a', 'b', 'g', 'e']);
    expect(ids(sortComparison(rows, { key: 'worstMtm', dir: 'asc' }))).toEqual([
      'a',
      'g',
      'b',
      'e',
    ]);
  });

  it('does not mutate its input', () => {
    const before = ids(rows);
    sortComparison(rows, { key: 'name', dir: 'desc' });
    expect(ids(rows)).toEqual(before);
  });
});

describe('nextSort / ariaSort', () => {
  it('flips the same column and starts a new one descending (name ascending)', () => {
    expect(nextSort(DEFAULT_SORT, 'total')).toEqual({ key: 'total', dir: 'asc' });
    expect(nextSort({ key: 'total', dir: 'asc' }, 'total')).toEqual({ key: 'total', dir: 'desc' });
    expect(nextSort(DEFAULT_SORT, 'winRate')).toEqual({ key: 'winRate', dir: 'desc' });
    expect(nextSort(DEFAULT_SORT, 'name')).toEqual({ key: 'name', dir: 'asc' });
  });

  it('reports aria-sort for the active column only', () => {
    expect(ariaSort(DEFAULT_SORT, 'total')).toBe('descending');
    expect(ariaSort({ key: 'total', dir: 'asc' }, 'total')).toBe('ascending');
    expect(ariaSort(DEFAULT_SORT, 'name')).toBe('none');
  });
});

describe('sparkline', () => {
  it('is empty with no points', () => {
    expect(sparkline([], 80, 24)).toEqual({ path: '', zeroY: null });
  });

  it('starts from zero and spans the box inside the padding', () => {
    const s = sparkline([100, -100], 84, 24, 2);
    expect(s.path).toBe('M2 12 L42 2 L82 22');
    expect(s.zeroY).toBe(12);
  });

  it('draws a segment for a single day', () => {
    expect(sparkline([50], 84, 24, 2).path).toBe('M2 22 L82 2');
  });

  it('puts a flat series mid-box instead of dividing by zero', () => {
    const s = sparkline([0, 0], 84, 24, 2);
    expect(s.path).toBe('M2 12 L42 12 L82 12');
    expect(s.zeroY).toBe(12);
  });
});

describe('day grid helpers', () => {
  it('labels DTE', () => {
    expect(dteText(undefined)).toBeNull();
    expect(dteText({ dte: null, is_expiry: null })).toBeNull();
    expect(dteText({ dte: 0, is_expiry: true })).toBe('Expiry');
    expect(dteText({ dte: 5, is_expiry: false })).toBe('5');
  });

  it('names the segments from the cuts', () => {
    expect(segmentNames(['10:30', '13:30'])).toEqual(['09:15–10:30', '10:30–13:30', '13:30–15:30']);
    expect(segmentNames([])).toEqual(['09:15–15:30']);
  });
});
