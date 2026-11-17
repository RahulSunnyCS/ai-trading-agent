import { describe, expect, it } from 'vitest';

import type { LiveBook, LivePick } from '../../types/rotationLiveBoard';
import {
  buildBookMatrix,
  buildMatrices,
  cellTone,
  columnsFor,
  labelMinute,
  lastMinute,
  minuteLabel,
  pickScale,
  totalScale,
  valueAt,
} from '../rotationLiveMatrix';

const pick = (over: Partial<LivePick> = {}): LivePick => ({
  variant: 'N_wide_0947',
  label: 'N_widesl_OTM1',
  params: '',
  role: 'core',
  underlying: 'NIFTY',
  entry_time: '09:47',
  exit_time: '15:28',
  state: 'open',
  legs: [],
  gross: 0,
  net: 0,
  net_slipped: 0,
  worst_mtm: 0,
  stopped_by: null,
  // enters at minute 32 (09:47)
  curve: [
    [32, 0],
    [33, 50],
    [40, 120],
    [44, -80],
  ],
  lots: 2,
  ...over,
});

const book = (picks: LivePick[], over: Partial<LiveBook> = {}): LiveBook => ({
  book: 't1',
  name: 'Adaptive Tuned',
  late: false,
  expiry_only: null,
  dte: null,
  accounts: [],
  picks,
  per_lot: { net: 0, net_slipped: 0 },
  yours: { net: 0, net_slipped: 0, lots: 0 },
  curve: [],
  curve_yours: [],
  ...over,
});

describe('live matrix time axis', () => {
  it('reads session minutes as IST clock times', () => {
    expect(minuteLabel(0)).toBe('09:15');
    expect(minuteLabel(15)).toBe('09:30');
    expect(minuteLabel(375)).toBe('15:30');
    expect(labelMinute('09:47')).toBe(32);
    expect(labelMinute('nope')).toBeNull();
  });

  it('takes the last bar as one minute before the snapshot as_of, or the newest curve point', () => {
    expect(lastMinute('09:47', [])).toBe(31);
    expect(lastMinute(null, [book([pick()])])).toBe(44);
    expect(lastMinute(null, [])).toBeNull();
  });

  it('makes one column per finished bucket and a partial one for the bucket in progress', () => {
    const cols = columnsFor(44, 15);
    expect(cols.map((c) => c.label)).toEqual(['09:30', '09:45', '10:00']);
    expect(cols.map((c) => c.minute)).toEqual([14, 29, 44]);
    expect(cols.map((c) => c.partial)).toEqual([false, false, false]); // 10:00 closes a bucket
    const open = columnsFor(40, 15);
    expect(open.map((c) => c.label)).toEqual(['09:30', '09:45', '09:56']);
    expect(open[2]).toMatchObject({ minute: 40, partial: true });
    expect(columnsFor(3, 5)).toEqual([{ minute: 3, label: '09:19', partial: true }]);
    expect(columnsFor(null, 15)).toEqual([]);
  });
});

describe('live matrix cells', () => {
  it('carries a curve forward and is empty before the first point', () => {
    const curve: [number, number][] = [
      [32, 0],
      [40, 120],
    ];
    expect(valueAt(curve, 31)).toBeNull();
    expect(valueAt(curve, 32)).toBe(0);
    expect(valueAt(curve, 39)).toBe(0);
    expect(valueAt(curve, 99)).toBe(120);
  });

  it('leaves a cell before entry empty, never zero', () => {
    const m = buildBookMatrix(book([pick()]), columnsFor(44, 15), 'lot');
    const cells = m.rows[0]?.cells ?? [];
    expect(cells.map((c) => c.value)).toEqual([null, null, -80]);
    expect(m.total).toEqual([null, null, -80]);
  });

  it('holds a closed pick at its last value and marks the held cells', () => {
    const closed = pick({
      state: 'closed',
      curve: [
        [0, 0],
        [10, 300],
        [20, -200],
      ],
    });
    const m = buildBookMatrix(book([closed]), columnsFor(44, 15), 'lot');
    const cells = m.rows[0]?.cells ?? [];
    expect(cells.map((c) => c.value)).toEqual([300, -200, -200]);
    expect(cells.map((c) => c.held)).toEqual([false, true, true]);
    expect(m.rows[0]?.latest).toBe(-200);
  });

  it('multiplies by the lots a pick trades in your lots, and not at all for none', () => {
    const traded = pick({ lots: 3, curve: [[0, 100]] });
    const idle = pick({ variant: 'S_x_0917', lots: 0, curve: [[0, 100]] });
    const yours = buildBookMatrix(book([traded, idle]), columnsFor(14, 15), 'yours');
    expect(yours.rows.map((r) => r.latest)).toEqual([300, 0]);
    expect(yours.total).toEqual([300]);
    const lot = buildBookMatrix(book([traded, idle]), columnsFor(14, 15), 'lot');
    expect(lot.rows.map((r) => r.latest)).toEqual([100, 100]);
    expect(lot.total).toEqual([200]);
  });

  it('sums rows into the total, counting a pick that has not entered as nothing', () => {
    const early = pick({
      variant: 'early',
      curve: [
        [0, 10],
        [20, 40],
      ],
    });
    const late = pick({ variant: 'late', curve: [[20, 5]] });
    const m = buildBookMatrix(book([early, late]), columnsFor(29, 15), 'lot');
    expect(m.total).toEqual([10, 45]);
  });

  it('agrees with the book curve at the same minute', () => {
    // book_curve (Python) sums each pick's curve per minute, 0 before it enters and its last value after
    const a = pick({
      variant: 'a',
      curve: [
        [0, 10],
        [20, 40],
      ],
    });
    const b = pick({
      variant: 'b',
      curve: [
        [5, -20],
        [25, 30],
      ],
    });
    const m = buildBookMatrix(book([a, b]), columnsFor(29, 15), 'lot');
    const curveAt = (minute: number) =>
      [a, b].reduce((s, p) => s + (valueAt(p.curve, minute) ?? 0), 0);
    expect(m.total).toEqual([curveAt(14), curveAt(29)]);
  });

  it('shows a snapshot with no curve as empty rows, not an error', () => {
    const m = buildMatrices([book([pick({ curve: [], state: 'waiting' })])], null, 15, 'lot');
    expect(m[0]?.columns).toEqual([]);
    expect(m[0]?.rows[0]?.cells).toEqual([]);
    expect(m[0]?.total).toEqual([]);
  });

  it('puts both books on the same columns', () => {
    const t1 = book([pick()]);
    const core = book([pick({ variant: 'c', curve: [[0, 1]] })], {
      book: 'core',
      name: 'Adaptive Classic',
    });
    const [a, b] = buildMatrices([t1, core], '10:00', 15, 'lot');
    expect(a?.columns).toEqual(b?.columns);
  });
});

describe('live matrix tint', () => {
  it('tints profit and loss apart, leaves empty cells clear, and scales rows and totals separately', () => {
    const ms = buildMatrices(
      [
        book([
          pick({
            curve: [
              [0, 100],
              [20, -400],
            ],
          }),
          pick({ variant: 'b', curve: [[0, 50]] }),
        ]),
      ],
      '10:00',
      15,
      'lot',
    );
    const rows = pickScale(ms);
    expect(rows?.limit).toBe(400);
    expect(totalScale(ms)?.limit).toBe(350);
    expect(cellTone(null, rows)).toBe('bg-transparent');
    expect(cellTone(400, rows)).toContain('bg-positive');
    expect(cellTone(-400, rows)).toContain('bg-negative');
    expect(cellTone(5, rows)).toBe('bg-surface-2'); // too small to tint
    expect(pickScale([])).toBeNull();
  });
});
