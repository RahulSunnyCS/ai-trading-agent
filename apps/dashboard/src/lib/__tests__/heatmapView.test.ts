import { describe, expect, it } from 'vitest';

import type { HeatmapCell, HeatmapResponse } from '../../types/heatmap';
import { cellClass, maxAbsOf, toCsv } from '../heatmapView';

const cell = (net: number, ce: number, pe: number): HeatmapCell => ({ net, ce, pe, n: 1 });

const response: HeatmapResponse = {
  underlying: 'NIFTY',
  kind: 'index',
  expiry: 'weekly',
  view: 'time_sl',
  metric: 'value',
  unit: 'inr_per_lot',
  lot: 65,
  exit_time: '15:30',
  exit_times: ['15:30', '15:15'],
  rows: ['09:16', '09:45'],
  columns: [10, 20],
  cells: [
    [cell(-100, 50, -150), null],
    [cell(200, 120, 80), cell(300, 200, 100)],
  ],
  row_totals: [cell(-100, 50, -150), cell(500, 320, 180)],
  column_totals: [cell(100, 170, -70), cell(300, 200, 100)],
  total: cell(400, 370, 30),
  days: ['2026-09-28'],
  filters: { from: null, to: null, sl: null, time: null, weeks_to_expiry: null },
};

describe('toCsv', () => {
  it('writes the grid with TOTAL row and column and blanks for a missing cell', () => {
    expect(toCsv(response, false)).toBe(
      [',10,20,TOTAL', '09:16,-100,,-100', '09:45,200,300,500', 'TOTAL,100,300,400', ''].join('\n'),
    );
  });

  it('writes a put block then a call block when split', () => {
    const lines = toCsv(response, true).split('\n');
    expect(lines).toContain('PUT');
    expect(lines).toContain('CALL');
    expect(lines).toContain('09:45,80,100,180');
    expect(lines).toContain('09:45,120,200,320');
  });
});

describe('cellClass', () => {
  it('tints profit and loss apart and leaves a missing cell neutral', () => {
    expect(cellClass(90, 100)).toContain('positive');
    expect(cellClass(-90, 100)).toContain('negative');
    expect(cellClass(null, 100)).toBe('bg-surface-2');
    expect(cellClass(0, 100)).toBe('bg-surface-2');
  });

  it('measures intensity against the biggest cell', () => {
    expect(maxAbsOf(response.cells)).toBe(300);
  });
});
