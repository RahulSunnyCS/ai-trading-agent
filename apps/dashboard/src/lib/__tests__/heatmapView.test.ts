import { describe, expect, it } from 'vitest';

import type { HeatmapCell, HeatmapResponse } from '../../types/heatmap';
import {
  cellClass,
  maxAbsOf,
  settingsChips,
  slLabel,
  slLevels,
  slOptionLabel,
  toCsv,
} from '../heatmapView';

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

describe('No SL level', () => {
  it('labels the 0 sentinel, leaves real stops as they are', () => {
    expect(slLabel(0)).toBe('No SL');
    expect(slLabel('0')).toBe('No SL');
    expect(slLabel(10)).toBe('10');
    expect(slOptionLabel(0)).toBe('No SL');
    expect(slOptionLabel(30)).toBe('30%');
  });

  it('reads the levels from the response, falling back for an older API', () => {
    expect(slLevels({ stop_losses: [10, 20], sl_levels: [10, 20, 0] })).toEqual([10, 20, 0]);
    expect(slLevels({ stop_losses: [10, 20] })).toEqual([10, 20]);
  });

  it('puts No SL in the CSV heading of an SL axis but leaves a time axis alone', () => {
    const withNoSl: HeatmapResponse = {
      ...response,
      columns: [10, 0],
      cells: [
        [cell(1, 1, 0), null],
        [cell(2, 1, 1), null],
      ],
    };
    expect(toCsv(withNoSl, false).split('\n')[0]).toBe(',10,No SL,TOTAL');
    const byTime: HeatmapResponse = { ...withNoSl, view: 'date_time', columns: ['09:16', '09:45'] };
    expect(toCsv(byTime, false).split('\n')[0]).toBe(',09:16,09:45,TOTAL');
  });
});

describe('settingsChips', () => {
  const base = {
    view: 'time_sl' as const,
    underlying: 'NIFTY',
    date: '2026-10-14',
    from: '2026-09-30',
    to: '',
    sl: 10,
    time: '09:45',
    exit: '15:30',
    metric: 'value' as const,
    weeks: [] as number[],
  };

  it('says the index, the table, the day, the exit and the unit', () => {
    expect(settingsChips(base)).toEqual([
      'NIFTY',
      'Time vs SL',
      '14 Oct 2026',
      'Exit 15:30',
      'Rupees',
    ]);
  });

  it('gives a range for a summed time-vs-SL table', () => {
    expect(settingsChips({ ...base, to: '2026-10-14', date: '2026-10-01' })).toContain(
      '01 Oct 2026 to 14 Oct 2026',
    );
  });

  it('adds the stop for date vs time and the entry for date vs SL', () => {
    const dateTime = settingsChips({ ...base, view: 'date_time', to: '2026-10-14' });
    expect(dateTime).toContain('SL 10%');
    const noSl = settingsChips({ ...base, view: 'date_time', sl: 0, to: '2026-10-14' });
    expect(noSl).toContain('SL No SL');
    const dateSl = settingsChips({ ...base, view: 'date_sl', to: '2026-10-14' });
    expect(dateSl).toContain('Entry 09:45');
  });

  it('names a pooled stock view, the percent unit and the weeks filter', () => {
    const chips = settingsChips({
      ...base,
      underlying: 'ALLSTOCKS',
      metric: 'pct',
      weeks: [0, 1],
    });
    expect(chips[0]).toBe('All stocks');
    expect(chips).toContain('% of premium');
    expect(chips).toContain('Weeks to expiry 0, 1');
  });
});
