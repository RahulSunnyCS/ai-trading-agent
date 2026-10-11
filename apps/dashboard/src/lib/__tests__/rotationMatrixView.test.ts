import { describe, expect, it } from 'vitest';

import type { MatrixCell, MatrixResponse, MatrixScale } from '../../types/rotationMatrix';
import {
  ANY,
  BAND_EDGES,
  type CellKind,
  DEFAULT_FILTERS,
  type MatrixFilters,
  bandOf,
  canCompare,
  cellKind,
  cellLabel,
  cellParams,
  cellText,
  curveGeometry,
  histogram,
  insightLines,
  isThin,
  legendSwatches,
  matrixParams,
  scaleNotes,
  settleActive,
  stepActive,
  stoppedShare,
  thinnest,
  toQuery,
  toneClass,
  valueText,
} from '../rotationMatrixView';

const DIVERGING: MatrixScale = {
  kind: 'diverging',
  min: -500,
  max: 500,
  limit: 500,
  clipped: false,
};
const SEQUENTIAL: MatrixScale = {
  kind: 'sequential',
  min: 0,
  max: 0.6,
  limit: 0.6,
  clipped: false,
};
const f = (patch: Partial<MatrixFilters> = {}): MatrixFilters => ({ ...DEFAULT_FILTERS, ...patch });

describe('colour bands', () => {
  it('puts the edges where the constants say, and zero in the neutral band', () => {
    expect(bandOf(0, 500)).toBe(0);
    expect(bandOf(500 * BAND_EDGES[0], 500)).toBe(0);
    expect(bandOf(500 * BAND_EDGES[0] + 1, 500)).toBe(1);
    expect(bandOf(500 * BAND_EDGES[1] + 1, 500)).toBe(2);
    expect(bandOf(500 * BAND_EDGES[2] + 1, 500)).toBe(3);
    expect(bandOf(500 * BAND_EDGES[3] + 1, 500)).toBe(4);
    expect(bandOf(5000, 500)).toBe(4); // beyond the limit is the top band, never an error
  });

  it('treats a missing value, a zero limit and a non-number as neutral', () => {
    expect(bandOf(null, 500)).toBe(0);
    expect(bandOf(undefined, 500)).toBe(0);
    expect(bandOf(Number.NaN, 500)).toBe(0);
    expect(bandOf(100, 0)).toBe(0);
  });

  it('colours rupees green above zero and red below, symmetric about zero', () => {
    expect(toneClass(450, DIVERGING, 'inr')).toBe('bg-positive/40');
    expect(toneClass(400, DIVERGING, 'inr')).toBe('bg-positive/30');
    expect(toneClass(-450, DIVERGING, 'inr')).toBe('bg-negative/40');
    expect(toneClass(60, DIVERGING, 'inr')).toBe('bg-surface-2');
    expect(toneClass(-150, DIVERGING, 'inr')).toBe(
      toneClass(150, DIVERGING, 'inr').replace('positive', 'negative'),
    );
  });

  it('uses one tint from zero for a rate, never the profit and loss colours', () => {
    expect(toneClass(0.6, SEQUENTIAL, 'fraction')).toBe('bg-series-1/40');
    expect(toneClass(0.02, SEQUENTIAL, 'fraction')).toBe('bg-surface-2');
    for (const v of [0, 0.1, 0.3, 0.5, 0.6]) {
      expect(toneClass(v, SEQUENTIAL, 'fraction')).not.toMatch(/positive|negative/);
    }
  });

  it('colours a difference of rates with the two series tints, not profit and loss', () => {
    const d: MatrixScale = { ...DIVERGING, limit: 0.2, min: -0.2, max: 0.2 };
    expect(toneClass(0.2, d, 'fraction', true)).toBe('bg-series-1/40');
    expect(toneClass(-0.2, d, 'fraction', true)).toBe('bg-series-2/40');
    expect(toneClass(300, DIVERGING, 'inr', true)).toBe('bg-positive/30');
  });

  it('shares one scale: the same value gets the same band from either period', () => {
    expect(toneClass(250, DIVERGING, 'inr')).toBe(toneClass(250, DIVERGING, 'inr'));
    const narrow: MatrixScale = { ...DIVERGING, limit: 250, min: -250, max: 250 };
    expect(toneClass(250, narrow, 'inr')).not.toBe(toneClass(250, DIVERGING, 'inr'));
  });

  it('draws a legend from one end of the scale to the other', () => {
    const l = legendSwatches(DIVERGING, 'inr');
    expect(l).toHaveLength(9);
    expect(l[0]?.edge).toBeLessThan(0);
    expect(l[4]?.edge).toBe(0);
    expect(l[8]?.edge).toBeGreaterThan(0);
    expect(l[0]?.edge).toBe(-(l[8]?.edge ?? 0));
    expect(legendSwatches(SEQUENTIAL, 'fraction')).toHaveLength(5);
    expect(legendSwatches(null, 'inr')).toEqual([]);
  });
});

describe('cells', () => {
  it('names a cell by what it lacks, and a genuine zero is a value', () => {
    expect(cellKind({ v: 0, n: 30, nv: 30 })).toBe('value');
    expect(cellKind({ v: null })).toBe('missing');
    expect(cellKind({ st: 'missing', reason: 'x' })).toBe('missing');
    expect(cellKind({ st: 'excluded', reason: 'x' })).toBe('excluded');
    expect(cellKind({ st: 'na' })).toBe('na');
    expect(cellKind(null)).toBe('na');
  });

  it('flags a thin sample by session count against the minimum', () => {
    expect(isThin(19, 20)).toBe(true);
    expect(isThin(20, 20)).toBe(false);
    expect(isThin(undefined, 20)).toBe(false);
    expect(thinnest([205, 12])).toBe(12);
    expect(thinnest(undefined)).toBeNull();
  });

  it('prints signed whole rupees, whole percent and percentage points', () => {
    expect(cellText(338.3, 'inr')).toBe('+338');
    expect(cellText(-1234.6, 'inr')).toBe('-1,235');
    expect(cellText(0.2, 'inr')).toBe('0');
    expect(cellText(-0.3, 'inr')).toBe('0');
    expect(cellText(0.4927, 'fraction')).toBe('49');
    expect(cellText(0.05, 'fraction', true)).toBe('+5');
    expect(cellText(null, 'inr')).toBe('');
    expect(valueText(338.3, 'inr')).toBe('+₹338');
    expect(valueText(null, 'inr')).toBe('—');
    expect(valueText(0.4927, 'fraction')).toBe('49.3%');
  });
});

describe('the request', () => {
  it('sends the defaults as a bare view and period', () => {
    expect(matrixParams(f())).toEqual({ view: 'family_slot', period: 'P1', metric: 'avg' });
    expect(toQuery(matrixParams(f()))).toBe('?view=family_slot&period=P1&metric=avg');
  });

  it('turns the compare switch into P1,P2 and drops the single period', () => {
    const p = matrixParams(f({ compare: true, period: 'P2' }));
    expect(p.compare).toBe('P1,P2');
    expect(p.period).toBeUndefined();
    expect(canCompare('date_slot')).toBe(false);
    expect(matrixParams(f({ view: 'date_slot', compare: true })).compare).toBeUndefined();
  });

  it('carries custom dates only for a custom period', () => {
    expect(matrixParams(f({ period: 'P2', from: '2025-02-01' })).from).toBeUndefined();
    expect(
      matrixParams(f({ period: 'custom', from: '2025-02-01', to: '2025-03-01' })),
    ).toMatchObject({
      period: 'custom',
      from: '2025-02-01',
      to: '2025-03-01',
    });
  });

  it('maps the single strategy kind to index and family for the date and DTE views', () => {
    const p = matrixParams(
      f({ view: 'date_slot', strategy: 'S:p250', index: 'NIFTY', family: 'dir' }),
    );
    expect(p.index).toBe('SENSEX');
    expect(p.family).toBe('p250');
    const q = matrixParams(f({ view: 'family_slot', index: 'NIFTY', family: 'widesl' }));
    expect([q.index, q.family]).toEqual(['NIFTY', 'widesl']);
  });

  it('percent-encodes the "+" and "<" in DTE and VIX-band labels', () => {
    const q = toQuery(matrixParams(f({ dte: '7+', vix: '<10.5' })));
    expect(q).toContain('dte=7%2B');
    expect(q).toContain('vix_band=%3C10.5');
  });

  it('asks for selection only when a list is chosen, and for selected-only only then', () => {
    expect(matrixParams(f({ metric: 'selection' })).metric).toBe('avg');
    const p = matrixParams(f({ metric: 'selection', list: 'A' }));
    expect(p).toMatchObject({ metric: 'selection', list: 'A' });
    expect(p.basis).toBeUndefined();
    expect(matrixParams(f({ list: 'REF', basis: 'selected' })).basis).toBe('selected');
    expect(matrixParams(f({ list: ANY, basis: 'selected' })).basis).toBeUndefined();
  });

  it('keeps the pulse as of one day whatever the period says', () => {
    const p = matrixParams(f({ view: 'pulse', period: 'P2', compare: true, to: '2026-10-09' }));
    expect(p.period).toBeUndefined();
    expect(p.compare).toBeUndefined();
    expect(p.to).toBe('2026-10-09');
  });

  it('builds the cell request from the same filters and the grid the cell sits in', () => {
    const p = cellParams(f({ index: 'NIFTY', list: 'B', compare: true }), 'N:wide', '0917', 'P2');
    expect(p).toMatchObject({
      view: 'family_slot',
      row: 'N:wide',
      col: '0917',
      period: 'P2',
      index: 'NIFTY',
      list: 'B',
    });
    expect(p.compare).toBeUndefined();
  });
});

function response(over: Partial<MatrixResponse> = {}): MatrixResponse {
  const cell = (v: number, n = 205): MatrixCell => ({ v, n, nv: n * 25 });
  return {
    available: true,
    view: 'family_slot',
    metric: 'avg',
    basis: 'all',
    list: null,
    unit: 'inr',
    metric_label: 'Average gross per one-lot strategy-day',
    aggregation: 'mean',
    selection_denominator: null,
    filters: { index: 'both', family: null, slot: null, weekday: null, dte: null, vix_band: null },
    min_n: 20,
    rows: [
      { key: 'N:wide', label: 'NIFTY Widesl OTM1' },
      { key: 'N:ditm1', label: 'NIFTY Dir ITM1' },
    ],
    cols: [
      { key: '0917', label: '09:17' },
      { key: '0932', label: '09:32' },
    ],
    periods: [
      {
        id: 'P1',
        label: 'P1 · Dec 2025 to Oct 2026',
        from: null,
        to: null,
        status: 'ok',
        reason: null,
        sessions: 207,
        waiting_on_results: null,
      },
      {
        id: 'P2',
        label: 'P2 · Jan to Aug 2025',
        from: null,
        to: null,
        status: 'ok',
        reason: null,
        sessions: 158,
        waiting_on_results: null,
      },
    ],
    matrices: [
      {
        period: 'P1',
        status: 'ok',
        reason: null,
        sessions: 207,
        cells: [
          [cell(100), cell(196)],
          [cell(300), cell(376)],
        ],
        row_summary: [cell(148), cell(338)],
        col_summary: [cell(200), cell(286)],
      },
      {
        period: 'P2',
        status: 'ok',
        reason: null,
        sessions: 158,
        cells: [
          [cell(300, 158), cell(420, 158)],
          [cell(250, 158), cell(320, 158)],
        ],
        row_summary: [cell(360, 158), cell(285, 158)],
        col_summary: [cell(275, 158), cell(370, 158)],
      },
    ],
    scale: DIVERGING,
    difference: null,
    overlay: {
      source: 'recorded',
      available: false,
      reason: 'no entry',
      entries: 0,
      on_time: 0,
      late: [],
      scored: 0,
      waiting_on_results: [],
      lists: ['A', 'B', 'C', 'REF'],
      reconstructed: '',
    },
    date_picks: null,
    as_of: null,
    meta: {} as MatrixResponse['meta'],
    all_periods: [],
    notes: [],
    ...over,
  };
}

describe('insight lines', () => {
  it('names the leader of each period with its number and sample, then whether it changes', () => {
    const lines = insightLines(response());
    expect(lines[0]).toContain('P1: NIFTY Dir ITM1 leads at +₹338');
    expect(lines[0]).toContain('over 205 sessions');
    expect(lines[1]).toContain('P2: NIFTY Widesl OTM1 leads at +₹360');
    expect(lines[2]).toBe(
      'The leader changes with the period: NIFTY Dir ITM1 in P1, NIFTY Widesl OTM1 in P2.',
    );
  });

  it('says so when the same one leads in both', () => {
    const r = response();
    const second = r.matrices[1];
    if (second)
      second.row_summary = [
        { v: 100, n: 158, nv: 3950 },
        { v: 400, n: 158, nv: 3950 },
      ];
    expect(insightLines(r).at(-1)).toBe('The same one leads in both periods: NIFTY Dir ITM1.');
  });

  it('prefers a solid sample over a thin leader and says when only thin cells exist', () => {
    const r = response();
    const first = r.matrices[0];
    if (first)
      first.row_summary = [
        { v: 148, n: 205, nv: 5125 },
        { v: 900, n: 4, nv: 100, thin: true },
      ];
    expect(insightLines(r)[0]).toContain('NIFTY Widesl OTM1 leads at +₹148');
    if (first)
      first.row_summary = [
        { v: 50, n: 3, nv: 75, thin: true },
        { v: 900, n: 4, nv: 100, thin: true },
      ];
    expect(insightLines(r)[0]).toContain('below the minimum sample');
  });

  it('reads the deepest day for the worst metric and the highest rate for stop-hit', () => {
    const w = response({ metric: 'worst' });
    const m = w.matrices[0];
    if (m)
      m.row_summary = [
        { v: -900, n: 205, nv: 5125 },
        { v: -4000, n: 205, nv: 5125 },
      ];
    expect(insightLines(w)[0]).toContain('NIFTY Dir ITM1 has the deepest worst day at -₹4,000');
    const s = response({ metric: 'stop_rate', unit: 'fraction' });
    const sm = s.matrices[0];
    if (sm)
      sm.row_summary = [
        { v: 0.2, n: 205, nv: 5125 },
        { v: 0.31, n: 205, nv: 5125 },
      ];
    expect(insightLines(s)[0]).toContain('is stopped most often at 31.0%');
  });

  it('says nothing for a period that is not available', () => {
    const r = response();
    r.matrices = [{ period: 'P3', status: 'unavailable', reason: 'not imported' }];
    expect(insightLines(r)).toEqual([]);
  });
});

describe('the drawer helpers', () => {
  it('bins values over their range and counts every one', () => {
    const bins = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(bins).toHaveLength(5);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(11);
    expect(bins[4]?.count).toBe(3); // the maximum lands in the last bin
    expect(histogram([])).toEqual([]);
    expect(histogram([5, 5, 5])).toEqual([{ lo: 5, hi: 5, count: 3 }]);
  });

  it('draws a running total with its zero line inside the box', () => {
    const g = curveGeometry([{ cum: 0 }, { cum: 100 }, { cum: -50 }, { cum: 20 }], 400, 100);
    expect(g).not.toBeNull();
    expect(g?.min).toBe(-50);
    expect(g?.max).toBe(100);
    expect(g?.zeroY).toBeGreaterThan(0);
    expect(g?.zeroY).toBeLessThan(100);
    expect(g?.path.split(' ')).toHaveLength(4);
    expect(curveGeometry([{ cum: 1 }], 400, 100)).toBeNull();
  });

  it('measures the share of sessions with a stop', () => {
    const day = (n_stopped: number) => ({
      day: 'd',
      weekday: 'Mon',
      gross: 0,
      n_variants: 1,
      n_stopped,
    });
    expect(stoppedShare([day(0), day(1), day(0), day(2)])).toBe(0.5);
    expect(stoppedShare([])).toBeNull();
  });
});

describe('request details the review found', () => {
  it('never sends "selected only" with the selection metric', () => {
    const p = matrixParams(f({ metric: 'selection', list: 'A', basis: 'selected' }));
    expect(p.metric).toBe('selection');
    expect(p.basis).toBeUndefined();
    expect(
      cellParams(f({ metric: 'selection', list: 'A', basis: 'selected' }), 'r', 'c', 'P1').basis,
    ).toBeUndefined();
    expect(matrixParams(f({ list: 'A', basis: 'selected' })).basis).toBe('selected');
  });

  it('sends the pulse cell no period (the pulse is not a period)', () => {
    const p = cellParams(f({ view: 'pulse', to: '2026-10-09' }), 'N:wide', '5', 'asof');
    expect(p.period).toBeUndefined();
    expect(p.to).toBe('2026-10-09');
    expect(cellParams(f(), 'N:wide', '0917', 'P2').period).toBe('P2');
  });
});

describe('keyboard and screen readers', () => {
  const k = (rows: string[]): CellKind[][] =>
    rows.map((r) => r.split('').map((ch) => (ch === 'x' ? 'na' : 'value')) as CellKind[]);

  it('settles the tab stop on a focusable cell inside the grid', () => {
    expect(settleActive([0, 0], k(['xv', 'vv']))).toEqual([0, 1]);
    expect(settleActive([9, 9], k(['vv', 'vv']))).toEqual([1, 1]); // view changed: clamp
    expect(settleActive([0, 0], k(['xx', 'xv']))).toEqual([1, 1]);
    expect(settleActive([3, 3], [])).toEqual([0, 0]);
  });

  it('skips not-applicable cells when arrowing and stays put at an edge', () => {
    const kinds = k(['vxv', 'vvv']);
    expect(stepActive([0, 0], [0, 1], kinds)).toEqual([0, 2]);
    expect(stepActive([0, 2], [0, 1], kinds)).toEqual([0, 2]);
    expect(stepActive([0, 0], [1, 0], kinds)).toEqual([1, 0]);
  });

  it('names a cell by value, sample, thin state and picks', () => {
    const label = cellLabel(
      'NIFTY Widesl OTM1',
      '09:17',
      { v: 148, n: 9, nv: 9, thin: true, sel: { A: 2 }, all: { v: 120, n: 40, nv: 40 } },
      'inr',
      false,
    );
    expect(label).toContain('+₹148');
    expect(label).toContain('9 sessions');
    expect(label).toContain('thin sample');
    expect(label).toContain('of 40 sessions');
    expect(label).toContain('A 2 times');
    expect(
      cellLabel(
        'r',
        'c',
        { st: 'excluded', reason: 'removed by the weekday filter' },
        'inr',
        false,
      ),
    ).toBe('r, c: excluded, removed by the weekday filter');
    expect(cellLabel('r', 'c', { st: 'na' }, 'inr', false)).toBe('r, c: not applicable');
  });

  it('states what the colour scale left out and what it clipped', () => {
    expect(
      scaleNotes({ ...DIVERGING, thin_excluded: true, percentile: 95, clipped: true }, 'inr'),
    ).toHaveLength(2);
    expect(scaleNotes({ ...DIVERGING, clipped: false, thin_excluded: false }, 'inr')).toEqual([]);
    expect(scaleNotes(null, 'inr')).toEqual([]);
  });
});
