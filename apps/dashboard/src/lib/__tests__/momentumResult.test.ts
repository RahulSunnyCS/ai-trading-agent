import { describe, expect, it } from 'vitest';

import {
  countVisibleWeeks,
  differenceByKey,
  heatLevel,
  isInactiveSignalAction,
  isRealRotation,
  longestHeldAssets,
  lookbackKeys,
  lookbackLabel,
  monthlyReturns,
  rangeCutoff,
  rangeStartIndex,
  rebaseFactor,
  rebaseSeries,
  signalActionTone,
  sliceSeries,
  thinRotations,
  yearlyFromMonthly,
} from '../momentumResult';

/** Weekly Fridays ending 2026-10-02, oldest first. */
function weeks(count: number): string[] {
  const end = Date.parse('2026-10-02T00:00:00Z');
  return Array.from({ length: count }, (_, i) =>
    new Date(end - (count - 1 - i) * 7 * 86_400_000).toISOString().slice(0, 10),
  );
}

describe('range slicing', () => {
  const dates = weeks(300); // ~5.75 years

  it('cuts N calendar years before the last date', () => {
    expect(rangeCutoff(dates, '1y')).toBe('2025-10-02');
    expect(rangeCutoff(dates, '3y')).toBe('2023-10-02');
    expect(rangeCutoff(dates, 'all')).toBeNull();
    expect(rangeCutoff([], '1y')).toBeNull();
  });

  it('starts at the first week on or after the cutoff', () => {
    const start = rangeStartIndex(dates, '1y');
    expect(dates[start]).toBe('2025-10-03');
    expect(dates.length - start).toBe(53);
  });

  it('returns everything for All and for a range longer than the data', () => {
    expect(rangeStartIndex(dates, 'all')).toBe(0);
    expect(rangeStartIndex(weeks(60), '5y')).toBe(0);
    expect(rangeStartIndex([], '3y')).toBe(0);
  });

  it('handles timestamps with a time part', () => {
    const stamped = dates.map((d) => `${d}T00:00:00`);
    expect(rangeStartIndex(stamped, '1y')).toBe(rangeStartIndex(dates, '1y'));
  });
});

describe('rebaseSeries', () => {
  it('starts the slice at the base and keeps every ratio', () => {
    const values = [100_000, 150_000, 200_000, 300_000, 450_000];
    const out = rebaseSeries(values, 2);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeCloseTo(100_000);
    expect((out[2] ?? 0) / (out[0] ?? 1)).toBeCloseTo(450_000 / 200_000);
    expect((out[1] ?? 0) / (out[0] ?? 1)).toBeCloseTo(300_000 / 200_000);
  });

  it('leaves the full series untouched at start 0', () => {
    expect(rebaseSeries([120_000, 130_000], 0)).toEqual([120_000, 130_000]);
  });

  it('keeps nulls and re-bases on the first usable value after the start', () => {
    const out = rebaseSeries([100, null, null, 400, 800, undefined], 1, 1000);
    expect(out).toEqual([null, null, 1000, 2000, null]);
  });

  it('only slices when nothing is usable', () => {
    expect(rebaseSeries([100, null, null], 1)).toEqual([null, null]);
    expect(rebaseFactor([null, 0, -5], 0)).toBeNull();
  });

  it('two series re-based at the same start both begin at the base', () => {
    const strategy = rebaseSeries([1, 2, 4, 8], 2);
    const benchmark = rebaseSeries([10, 11, 12, 18], 2);
    expect(strategy[0]).toBeCloseTo(benchmark[0] ?? Number.NaN);
    expect(benchmark[1]).toBeCloseTo(150_000);
  });

  it('sliceSeries drops the leading values only', () => {
    expect(sliceSeries([1, null, 3], 1)).toEqual([null, 3]);
    expect(sliceSeries([1, 2], -4)).toEqual([1, 2]);
  });
});

describe('thinRotations', () => {
  const topUp = { outs: [], ins: [{ top_up: true }], parked: false };
  const swap = { outs: [{}], ins: [{ top_up: false }], parked: false };
  const park = { outs: [], ins: [], parked: true };

  it('classifies a real change', () => {
    expect(isRealRotation(topUp)).toBe(false);
    expect(isRealRotation(swap)).toBe(true);
    expect(isRealRotation(park)).toBe(true);
    expect(isRealRotation({ outs: [], ins: [{}], parked: false })).toBe(true);
  });

  it('keeps every marker when zoomed in, up to and including the threshold', () => {
    const rotations = [topUp, swap, topUp];
    expect(thinRotations(rotations, 150)).toHaveLength(3);
    expect(thinRotations(rotations, 40)).toHaveLength(3);
  });

  it('keeps only real changes when zoomed out', () => {
    expect(thinRotations([topUp, swap, topUp, park], 151)).toEqual([swap, park]);
  });

  it('falls back to every Nth real change above the marker cap, deterministically', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ ...swap, id: i }));
    const out = thinRotations(many, 520, { maxMarkers: 80 });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out[0]?.id).toBe(0);
    expect(out[1]?.id).toBe(7); // ceil(500 / 80)
    expect(thinRotations(many, 520, { maxMarkers: 80 })).toEqual(out);
  });

  it('counts the weeks inside a window', () => {
    const dates = weeks(10);
    expect(countVisibleWeeks(dates, null, null)).toBe(10);
    expect(countVisibleWeeks(dates, dates[7] ?? null, null)).toBe(3);
    expect(countVisibleWeeks(dates, `${dates[2]} 12:00`, `${dates[4]}T00:00`)).toBe(3);
  });
});

describe('monthly and yearly resampling', () => {
  const dates = ['2023-12-22', '2023-12-29', '2024-01-12', '2024-01-26', '2024-02-23'];
  const values = [100, 110, 121, null, 133.1];

  it('measures the first month from the first value and skips nulls', () => {
    const monthly = monthlyReturns(dates, values);
    expect(monthly.get('2023-12')).toBeCloseTo(0.1);
    expect(monthly.get('2024-01')).toBeCloseTo(0.1);
    expect(monthly.get('2024-02')).toBeCloseTo(0.1);
  });

  it('compounds months into the year total', () => {
    const yearly = yearlyFromMonthly(monthlyReturns(dates, values));
    expect(yearly.get('2023')).toBeCloseTo(0.1);
    expect(yearly.get('2024')).toBeCloseTo(133.1 / 110 - 1);
  });

  it('subtracts only where both sides have a value', () => {
    const diff = differenceByKey(
      new Map([
        ['a', 0.05],
        ['b', 0.01],
      ]),
      new Map([['a', 0.02]]),
    );
    expect(diff.get('a')).toBeCloseTo(0.03);
    expect(diff.has('b')).toBe(false);
  });

  it('buckets intensity by magnitude, not sign', () => {
    expect(heatLevel(undefined)).toBe(0);
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(0.01)).toBe(1);
    expect(heatLevel(-0.03)).toBe(2);
    expect(heatLevel(0.07)).toBe(3);
    expect(heatLevel(-0.25)).toBe(4);
  });
});

describe('longestHeldAssets', () => {
  const rows = [
    { asset: 'A', start: '2024-01-05', end: '2024-02-02' }, // 4w
    { asset: 'B', start: '2024-01-05', end: '2024-06-07' }, // 22w
    { asset: 'A', start: '2024-03-01', end: '2024-09-06' }, // +27w
    { asset: 'C', start: '2024-01-05', end: '2024-01-12' }, // 1w
    { asset: 'D', start: 'bad', end: '2024-01-12' },
  ];

  it('ranks by total time held and reports how many there are', () => {
    expect(longestHeldAssets(rows, 2)).toEqual({ assets: ['A', 'B'], total: 4 });
  });

  it('returns every instrument when n covers them all', () => {
    expect(longestHeldAssets(rows).assets).toEqual(['A', 'B', 'C', 'D']);
    expect(longestHeldAssets([])).toEqual({ assets: [], total: 0 });
  });
});

describe('signal actions', () => {
  it('maps every action the engine emits to one tone', () => {
    expect(signalActionTone('BUY')).toBe('positive');
    expect(signalActionTone('BUY (make room)')).toBe('positive');
    expect(signalActionTone('BUY / TOP UP')).toBe('positive');
    expect(signalActionTone('ADD')).toBe('positive');
    expect(signalActionTone('SELL')).toBe('negative');
    expect(signalActionTone('TRIM to 25%')).toBe('negative');
    expect(signalActionTone('WAIT')).toBe('warning');
    expect(signalActionTone('WAITING FOR A SALE')).toBe('warning');
    expect(signalActionTone('AT CAP')).toBe('warning');
    expect(signalActionTone('HOLD')).toBe('neutral');
    expect(signalActionTone('PARK')).toBe('neutral');
    expect(signalActionTone('NOT A MEMBER')).toBe('neutral');
    expect(signalActionTone('')).toBe('neutral');
    expect(signalActionTone(null)).toBe('neutral');
  });

  it('flags only NOT A MEMBER as inactive', () => {
    expect(isInactiveSignalAction('NOT A MEMBER')).toBe(true);
    expect(isInactiveSignalAction('HOLD')).toBe(false);
    expect(isInactiveSignalAction(undefined)).toBe(false);
  });

  it('orders lookback keys numerically and labels them in weeks', () => {
    expect(
      lookbackKeys([{ returns: { '26': 0.1, '4': null } }, { returns: { '13': 0.2 } }, {}]),
    ).toEqual(['4', '13', '26']);
    expect(lookbackKeys([{ returns: { ytd: 1, '4': 1 } }])).toEqual(['4', 'ytd']);
    expect(lookbackLabel('13')).toBe('13w');
    expect(lookbackLabel('ytd')).toBe('ytd');
  });
});
