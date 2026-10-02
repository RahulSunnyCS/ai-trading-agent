import { describe, expect, it } from 'vitest';

import type { AnatomySegment, DayAnatomy, SegmentLabel } from '../../types/legwise';
import { MIN_BUCKET_N, bucketByLabel, scatterPoints, styleProxies, zscore } from '../legwiseJoin';

const STATES = ['TREND_UP', 'TREND_DOWN', 'CHOP', 'QUIET'];

function seg(label: SegmentLabel, over: Partial<AnatomySegment> = {}): AnatomySegment {
  return {
    start: '09:15',
    end: '15:30',
    ret_pct: 0.5,
    range_pct: 0.8,
    er: 0.3,
    strength: 3,
    rv_ann_pct: 12,
    implied_pct: 0.9,
    range_over_implied: 1.1,
    label,
    ...over,
  };
}

const day = (d: string, label: SegmentLabel, over: Partial<AnatomySegment> = {}): DayAnatomy => ({
  day: d,
  weekday: 'Mon',
  gap_pct: null,
  vix_open: 14,
  dte: null,
  is_expiry: null,
  whole: seg(label, over),
  segments: [seg(label, over)],
});

const A = [day('2026-09-01', 'CHOP'), day('2026-09-02', 'TREND_UP'), day('2026-09-03', 'QUIET')];

describe('bucketByLabel', () => {
  const pnl = [
    { day: '2026-09-01', net: -100 },
    { day: '2026-09-02', net: 300 },
    { day: '2026-09-03', net: 50 },
  ];

  it('same-day lens groups each day by ITS OWN label', () => {
    const b = bucketByLabel(pnl, A, -1, 'same', STATES);
    expect(b.find((x) => x.label === 'TREND_UP')).toMatchObject({ n: 1, mean: 300, winRate: 1 });
    expect(b.find((x) => x.label === 'CHOP')).toMatchObject({ n: 1, mean: -100, winRate: 0 });
    expect(b.find((x) => x.label === 'TREND_DOWN')).toMatchObject({
      n: 0,
      mean: null,
      winRate: null,
    });
  });

  it("lag-1 lens groups each day by the PREVIOUS day's label, and drops the first day", () => {
    const b = bucketByLabel(pnl, A, -1, 'lag1', STATES);
    // 09-02 follows a CHOP day, 09-03 follows a TREND_UP day; 09-01 has no predecessor
    expect(b.find((x) => x.label === 'CHOP')).toMatchObject({ n: 1, mean: 300 });
    expect(b.find((x) => x.label === 'TREND_UP')).toMatchObject({ n: 1, mean: 50 });
    expect(b.reduce((n, x) => n + x.n, 0)).toBe(2);
  });

  it('lag-1 follows the previous COLLECTED day across a gap, regardless of input order', () => {
    const shuffledAnatomy = [A[2] as DayAnatomy, A[0] as DayAnatomy, A[1] as DayAnatomy];
    const b = bucketByLabel(pnl, shuffledAnatomy, -1, 'lag1', STATES);
    expect(b.find((x) => x.label === 'CHOP')?.n).toBe(1);
  });

  it('skips P&L days with no anatomy and unknown labels instead of guessing', () => {
    const b = bucketByLabel(
      [
        { day: '2026-12-31', net: 1 },
        { day: '2026-09-02', net: 2 },
      ],
      [day('2026-09-02', 'UNKNOWN')],
      -1,
      'same',
      STATES,
    );
    expect(b.reduce((n, x) => n + x.n, 0)).toBe(0);
  });

  it('exposes the small-sample bar the UI greys against', () => {
    expect(MIN_BUCKET_N).toBeGreaterThan(1);
  });
});

describe('scatterPoints', () => {
  it('pairs ₹/lot with range ÷ implied and skips days without VIX', () => {
    const anat = [
      day('2026-09-01', 'CHOP', { range_over_implied: 0.7 }),
      day('2026-09-02', 'CHOP', { range_over_implied: null }),
    ];
    const pts = scatterPoints(
      [
        { day: '2026-09-01', net: 120 },
        { day: '2026-09-02', net: 5 },
        { day: '2026-09-09', net: 9 },
      ],
      anat,
      -1,
    );
    expect(pts).toEqual([{ day: '2026-09-01', x: 0.7, y: 120 }]);
  });
});

describe('styleProxies', () => {
  it('premium proxy = implied − |move|; directional = ER × |move|; rolling sums once the window fills', () => {
    const anat = [
      day('2026-09-01', 'CHOP', { implied_pct: 1, ret_pct: 0.2, er: 0.1 }),
      day('2026-09-02', 'CHOP', { implied_pct: 1, ret_pct: -1.5, er: 0.8 }),
      day('2026-09-03', 'CHOP', { implied_pct: 1, ret_pct: 0.1, er: 0.1 }),
    ];
    const { premium, directional } = styleProxies(anat, -1, 2);
    expect(premium.map((p) => p.time)).toEqual(['2026-09-02', '2026-09-03']);
    expect(premium[0]?.value).toBeCloseTo(0.8 + -0.5);
    expect(premium[1]?.value).toBeCloseTo(-0.5 + 0.9);
    expect(directional[0]?.value).toBeCloseTo(0.02 + 1.2);
  });

  it('skips days with no implied move (no VIX) rather than treating them as zero', () => {
    const anat = [day('2026-09-01', 'CHOP', { implied_pct: null }), day('2026-09-02', 'CHOP')];
    expect(styleProxies(anat, -1, 1).premium).toHaveLength(1);
  });
});

describe('zscore', () => {
  it('centres on 0 with unit spread and keeps the times', () => {
    const z = zscore([
      { time: 'a', value: 1 },
      { time: 'b', value: 3 },
      { time: 'c', value: 5 },
    ]);
    expect(z.map((p) => p.time)).toEqual(['a', 'b', 'c']);
    expect(z.reduce((a, p) => a + p.value, 0)).toBeCloseTo(0);
    expect(Math.sqrt(z.reduce((a, p) => a + p.value ** 2, 0) / 3)).toBeCloseTo(1);
  });

  it('maps a flat series to zeros (not NaN) and an empty one to empty', () => {
    expect(
      zscore([
        { time: 'a', value: 2 },
        { time: 'b', value: 2 },
      ]).map((p) => p.value),
    ).toEqual([0, 0]);
    expect(zscore([])).toEqual([]);
  });
});
