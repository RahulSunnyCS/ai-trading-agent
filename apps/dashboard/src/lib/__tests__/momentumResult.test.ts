import { describe, expect, it } from 'vitest';

import {
  countVisibleWeeks,
  differenceByKey,
  drawdownStats,
  fitNames,
  fittedNamesText,
  headroomRange,
  heatLevel,
  isInactiveSignalAction,
  isRealRotation,
  latestValue,
  longestHeldAssets,
  longestUnderwater,
  lookbackKeys,
  lookbackLabel,
  monthlyReturns,
  rangeCutoff,
  rangeStartIndex,
  rebaseFactor,
  rebaseSeries,
  rotationKind,
  rotationMarkersShown,
  rotationOnOrBefore,
  signalActionTone,
  sliceSeries,
  thinRotations,
  tooltipPlacement,
  weekChangeCounts,
  weekReturn,
  weekSummary,
  weekSummaryText,
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

describe('fitNames', () => {
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];

  it('shows every name when they fit', () => {
    // 5 + 5 + 7 + 5 + 4 letters and four ", " separators = 34 characters.
    expect(fitNames(names, 34)).toEqual({ shown: names, more: 0 });
    expect(fitNames([], 10)).toEqual({ shown: [], more: 0 });
  });

  it('keeps room for "+N more" when it cuts the list', () => {
    // "Alpha, Bravo" is 12; with the 10 kept free for "+N more" that needs 22.
    expect(fitNames(names, 22)).toEqual({ shown: ['Alpha', 'Bravo'], more: 3 });
    expect(fitNames(names, 21)).toEqual({ shown: ['Alpha'], more: 4 });
    expect(fittedNamesText(fitNames(names, 22))).toBe('Alpha, Bravo +3 more');
  });

  it('always shows the first name, even over budget', () => {
    expect(fitNames(names, 0)).toEqual({ shown: ['Alpha'], more: 4 });
    expect(fitNames(['A very long instrument name'], 3)).toEqual({
      shown: ['A very long instrument name'],
      more: 0,
    });
  });

  it('cuts to "+1 more" when the last name does not fit', () => {
    const fitted = fitNames(['Alpha', 'Bravo'], 8);
    expect(fitted).toEqual({ shown: ['Alpha'], more: 1 });
  });
});

describe('weekSummary', () => {
  const rotation = {
    outs: [{ asset: 'Old One' }, { asset: 'Old Two' }],
    ins: [
      { asset: 'New One', top_up: false },
      { asset: 'Topped', top_up: true },
    ],
    trims: [{ asset: 'Big' }],
    parked: false,
  };

  it('describes a rotation week', () => {
    const summary = weekSummary(rotation, 5, 200);
    expect(summary.kind).toBe('rotation');
    expect(summary.inCount).toBe(1);
    expect(summary.outCount).toBe(2);
    expect(summary.toppedUp).toBe(1);
    expect(summary.trimmed).toBe(1);
    expect(weekSummaryText(summary)).toBe(
      '▲ 1 in New One · ▼ 2 out Old One, Old Two · 1 topped up · 1 trimmed · Held 5',
    );
    expect(weekChangeCounts(summary)).toBe('1 in · 2 out · 1 topped up · 1 trimmed');
  });

  it('truncates entry and exit names to one shared budget', () => {
    const many = {
      outs: Array.from({ length: 10 }, (_, i) => ({ asset: `Exit Name ${i}` })),
      ins: Array.from({ length: 8 }, (_, i) => ({ asset: `Entry Name ${i}` })),
      trims: [],
      parked: false,
    };
    const summary = weekSummary(many, 20, 60);
    expect(summary.inCount).toBe(8);
    expect(summary.outCount).toBe(10);
    expect(summary.ins.shown.length + summary.ins.more).toBe(8);
    expect(summary.outs.shown.length + summary.outs.more).toBe(10);
    expect(fittedNamesText(summary.ins).length).toBeLessThanOrEqual(30);
    // What the entries leave unused goes to the exits; together they stay inside the budget.
    expect(
      fittedNamesText(summary.ins).length + fittedNamesText(summary.outs).length,
    ).toBeLessThanOrEqual(60);
    expect(summary.ins.more).toBeGreaterThan(0);
  });

  it('gives one side the room the other does not use', () => {
    const lopsided = {
      outs: [{ asset: 'X' }],
      ins: Array.from({ length: 6 }, (_, i) => ({ asset: `Entry ${i}` })),
      trims: [],
      parked: false,
    };
    // Six names of 7 characters and five separators = 52; the exit needs 1 of the 60.
    expect(weekSummary(lopsided, 6, 60).ins.more).toBe(0);
  });

  it('reads "No change" for a week without a rotation', () => {
    const summary = weekSummary(undefined, 5, 80);
    expect(summary.kind).toBe('none');
    expect(weekSummaryText(summary)).toBe('No change · Held 5');
    expect(weekChangeCounts(summary)).toBe('No change');
    expect(weekSummaryText(weekSummary(null, null, 80))).toBe('No change');
  });

  it('says so when the week is parked in the liquid fund', () => {
    const parked = { outs: [{ asset: 'Old One' }], ins: [], trims: [], parked: true };
    const summary = weekSummary(parked, 0, 80);
    expect(summary.kind).toBe('parked');
    expect(weekSummaryText(summary)).toBe('▼ 1 out Old One · Parked in the liquid fund');
    // Still parked in a later week with no trades: nothing is held.
    expect(weekSummaryText(weekSummary(undefined, 0, 80))).toBe('Parked in the liquid fund');
  });
});

describe('rotationKind', () => {
  const base = { outs: [], ins: [], trims: [], parked: false };
  it('colours the marker by what happened', () => {
    expect(rotationKind({ ...base, ins: [{ top_up: false }] })).toBe('added');
    expect(rotationKind({ ...base, outs: [{}] })).toBe('out');
    expect(rotationKind({ ...base, outs: [{}], ins: [{ top_up: false }] })).toBe('both');
    expect(rotationKind({ ...base, ins: [{ top_up: true }] })).toBe('other');
    expect(rotationKind({ ...base, parked: true })).toBe('other');
    // A top-up is not an entry.
    expect(rotationKind({ ...base, outs: [{}], ins: [{ top_up: true }] })).toBe('out');
  });

  it('draws Broad markers only at a year or less', () => {
    expect(rotationMarkersShown(false, 900)).toBe(true);
    expect(rotationMarkersShown(true, 53)).toBe(true);
    expect(rotationMarkersShown(true, 52)).toBe(true);
    expect(rotationMarkersShown(true, 54)).toBe(false);
  });
});

describe('headroomRange', () => {
  const dates = ['2024-01-05', '2024-01-12', '2024-01-19', '2024-01-26'];

  it('linear: from zero to 1.28 × the highest visible value of every line', () => {
    const range = headroomRange(
      [
        { dates, values: [1, 2, 3, 2] },
        { dates, values: [1, 1.5, 4, 1] },
      ],
      null,
      null,
      false,
    );
    expect(range?.[0]).toBe(0);
    expect(range?.[1]).toBeCloseTo(4 * 1.28);
  });

  it('keeps a negative low and only counts the window plus its edge neighbours', () => {
    const line = { dates, values: [-1, 2, 9, 3] };
    // Window 12 Jan..12 Jan: the neighbours 5 Jan (-1) and 19 Jan (9) are drawn too.
    const range = headroomRange([line], '2024-01-12', '2024-01-12 18:00', false);
    expect(range?.[0]).toBe(-1);
    expect(range?.[1]).toBeCloseTo(9 * 1.28);
    // Window 26 Jan on: only 19 Jan (9) and 26 Jan (3).
    expect(headroomRange([line], '2024-01-26', null, false)?.[1]).toBeCloseTo(9 * 1.28);
    // A window between two points still sees the segment through it.
    const between = headroomRange([line], '2024-01-14', '2024-01-16', false);
    expect(between?.[1]).toBeCloseTo(9 * 1.28);
  });

  it('log: extends the top by log10(1.35) and pads the floor by 2 % of the span', () => {
    const range = headroomRange([{ dates, values: [1, 10, 100, 0] }], null, null, true);
    expect(range?.[1]).toBeCloseTo(2 + Math.log10(1.35));
    // Zero is skipped on a log axis; the span 0..2 gives a 0.04 floor pad.
    expect(range?.[0]).toBeCloseTo(-0.04);
  });

  it('skips nulls and gives null when nothing is visible', () => {
    expect(
      headroomRange([{ dates, values: [null, 2, undefined, null] }], null, null, false)?.[1],
    ).toBeCloseTo(2.56);
    expect(headroomRange([], null, null, false)).toBeNull();
    expect(
      headroomRange([{ dates, values: [null, null, null, null] }], null, null, true),
    ).toBeNull();
    expect(headroomRange([{ dates, values: [0, -1, 0, 0] }], null, null, true)).toBeNull();
    expect(headroomRange([{ dates, values: [0, 0, 0, 0] }], null, null, false)).toBeNull();
  });
});

describe('tooltipPlacement', () => {
  const bounds = { left: 0, top: 0, right: 1000, bottom: 800 };
  const size = { width: 300, height: 200 };

  it('sits centred, 40 px below the cursor', () => {
    expect(tooltipPlacement({ x: 500, y: 100 }, size, bounds)).toEqual({
      left: 350,
      top: 140,
      above: false,
    });
  });

  it('flips above the cursor when below would overflow the bottom', () => {
    expect(tooltipPlacement({ x: 500, y: 600 }, size, bounds)).toEqual({
      left: 350,
      top: 360,
      above: true,
    });
  });

  it('slides sideways to stay inside the edges', () => {
    expect(tooltipPlacement({ x: 950, y: 100 }, size, bounds).left).toBe(700);
    expect(tooltipPlacement({ x: 40, y: 100 }, size, bounds).left).toBe(0);
  });

  it('stays inside the top-left when nothing fits', () => {
    expect(
      tooltipPlacement({ x: 20, y: 20 }, { width: 300, height: 900 }, { ...bounds, right: 200 }),
    ).toEqual({ left: 0, top: 0, above: true });
  });
});

describe('weekReturn and rotationOnOrBefore', () => {
  it('measures a week against the one before', () => {
    expect(weekReturn([100, 110, 99], 1)).toBeCloseTo(0.1);
    expect(weekReturn([100, 110, 99], 2)).toBeCloseTo(-0.1);
    expect(weekReturn([100, 110], 0)).toBeNull();
    expect(weekReturn([null, 110], 1)).toBeNull();
    expect(weekReturn([100, null], 1)).toBeNull();
  });

  it('finds the last rotation on or before a day', () => {
    const rotations = [{ week: '2026-01-02' }, { week: '2026-01-16T00:00:00' }];
    expect(rotationOnOrBefore(rotations, '2026-01-01')).toBeNull();
    expect(rotationOnOrBefore(rotations, '2026-01-09')?.week).toBe('2026-01-02');
    expect(rotationOnOrBefore(rotations, '2026-01-16')?.week).toBe('2026-01-16T00:00:00');
    expect(rotationOnOrBefore(rotations, '2026-03-01')?.week).toBe('2026-01-16T00:00:00');
  });
});

describe('longestUnderwater', () => {
  const dates = weeks(10);

  it('is null when the strategy never fell below a peak', () => {
    expect(longestUnderwater(dates, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(longestUnderwater([], [])).toBeNull();
  });

  it('counts the weeks from a peak to the week it is regained', () => {
    //                 peak            recovered   peak        recovered
    const drawdown = [0, -0.1, -0.2, -0.05, 0, 0, -0.1, 0, 0, 0];
    expect(longestUnderwater(dates, drawdown)).toEqual({
      weeks: 4,
      from: dates[0],
      to: dates[4],
      ongoing: false,
    });
  });

  it('reports a spell that has not recovered by the last week', () => {
    const drawdown = [0, -0.1, 0, 0, -0.1, -0.2, -0.3, -0.2, -0.1, -0.05];
    expect(longestUnderwater(dates, drawdown)).toEqual({
      weeks: 6,
      from: dates[3],
      to: dates[9],
      ongoing: true,
    });
  });

  it('treats a missing value as at the peak', () => {
    const drawdown = [null, -0.1, -0.1, 0, 0, 0, 0, 0, 0, 0];
    expect(longestUnderwater(dates, drawdown)?.weeks).toBe(3);
  });

  it('feeds drawdownStats with the trough and the current drawdown', () => {
    const drawdown = [0, -0.1, -0.25, -0.05, 0, 0, -0.1, 0, -0.02, -0.04];
    const stats = drawdownStats(dates, drawdown);
    expect(stats.max).toBe(-0.25);
    expect(stats.troughDate).toBe(dates[2]);
    expect(stats.current).toBe(-0.04);
    expect(stats.underwater?.weeks).toBe(4);
    expect(drawdownStats([], [])).toEqual({
      max: null,
      troughDate: null,
      current: null,
      underwater: null,
    });
  });
});

describe('latestValue', () => {
  it('skips trailing gaps', () => {
    const dates = weeks(4);
    expect(latestValue(dates, [null, 0.1, 0.2, null])).toEqual({ value: 0.2, date: dates[2] });
    expect(latestValue(dates, [null, null, null, null])).toBeNull();
  });
});
