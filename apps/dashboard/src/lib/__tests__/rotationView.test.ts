import { describe, expect, it } from 'vitest';

import type { RotationListStats, RotationSummary } from '../../types/rotation';
import {
  benchmarkFigures,
  headline,
  heroSeries,
  nearestIndex,
  niceTicks,
  readoutProgress,
  tooltipPlacement,
} from '../rotationView';

function stats(over: Partial<RotationListStats> = {}): RotationListStats {
  return {
    total: 30000,
    mean_day: 1500,
    per_lot_day: 250,
    lots_per_day: 6,
    max_drawdown: -8000,
    max_drawdown_per_lot: -1300,
    beats_random_pct: 71,
    random: { p10: 5000, p50: 18000, p90: 30000, max: 41000 },
    mean_daily_random_percentile: 58,
    random_path: { p10: [100, 200], p50: [900, 1800], p90: [1700, 3400] },
    vs_base: { mean: 20, lower: -50, upper: 90, drawdown_no_worse: true, beats_base: false },
    vs_ref: { mean: 10, lower: -40, upper: 60 },
    ...over,
  };
}

function summary(): RotationSummary {
  return {
    settings: {
      lots_per_strategy: 2,
      random_runs: 1000,
      random_seed: 57,
      bootstrap_resamples: 2000,
      bootstrap_block_days: 5,
      bootstrap_seed: 20261012,
      interval: 0.9,
      basis: 'gross',
    },
    n_days: 2,
    first_day: '2026-10-12',
    last_day: '2026-10-13',
    pending_days: [],
    pending_reasons: {},
    late_entries: [],
    short: true,
    lists: {
      A: stats(),
      REF: stats({ total: 19000, max_drawdown: -8800, per_lot_day: 170, beats_random_pct: 52 }),
    },
    base: {
      definition: 'base',
      per_lot_day: 100,
      cumulative_per_lot: 200,
      max_drawdown_per_lot: -900,
      lots_per_day: 6,
      total: 1200,
      max_drawdown: -5400,
    },
    days: [
      { day: '2026-10-12', base: 100, base_total: 600, A_total: 1000, REF_total: 800 },
      { day: '2026-10-13', base: 100, base_total: 600, A_total: -300, REF_total: 500 },
    ],
  };
}

describe('benchmarkFigures', () => {
  it('reads REF, the base and the random median from the summary', () => {
    const s = summary();
    expect(benchmarkFigures(s, 'REF', 'A').total).toBe(19000);
    expect(benchmarkFigures(s, 'base', 'A').perLotDay).toBe(100);
    const r = benchmarkFigures(s, 'random', 'A');
    expect(r.total).toBe(18000);
    expect(r.perLotDay).toBeCloseTo(18000 / (6 * 2));
    expect(r.beatsRandom).toBe(50);
  });

  it('gives nulls, not zeros, when the benchmark has no data', () => {
    const s = { ...summary(), base: null };
    expect(benchmarkFigures(s, 'base', 'A').total).toBeNull();
    expect(benchmarkFigures({ ...s, lists: {} }, 'REF', 'A').perLotDay).toBeNull();
  });
});

describe('headline', () => {
  it('sets each figure against the benchmark and signs the drawdown tone correctly', () => {
    const h = headline(summary(), 'A', 'REF', 60);
    const byId = Object.fromEntries(h.map((x) => [x.id, x]));
    expect(byId.total?.gap).toBe(11000);
    expect(byId.total?.tone).toBe('positive');
    // -8000 against -8800 is a smaller drawdown: better, although the number is larger
    expect(byId.drawdown?.gap).toBe(800);
    expect(byId.drawdown?.tone).toBe('positive');
    expect(byId.sessions?.value).toBe(2);
    expect(byId.sessions?.benchmark).toBe(60);
  });

  it('is empty when the focus list has no figures yet', () => {
    expect(headline({ ...summary(), lists: {} }, 'A', 'REF', 60)).toEqual([]);
  });
});

describe('heroSeries', () => {
  it('accumulates each list and the base day by day and carries the focus list band', () => {
    const pts = heroSeries(summary(), 'A');
    expect(pts.map((p) => p.lists.A)).toEqual([1000, 700]);
    expect(pts.map((p) => p.lists.REF)).toEqual([800, 1300]);
    expect(pts.map((p) => p.base)).toEqual([600, 1200]);
    expect(pts[1]?.band).toEqual({ p10: 200, p50: 1800, p90: 3400 });
  });

  it('is empty before the first scored day', () => {
    const { days: _days, ...s } = summary();
    expect(heroSeries(s, 'A')).toEqual([]);
  });
});

describe('small helpers', () => {
  it('readoutProgress clamps and flags done', () => {
    expect(readoutProgress(18, 60).fraction).toBeCloseTo(0.3);
    expect(readoutProgress(75, 60)).toMatchObject({ fraction: 1, done: true });
    expect(readoutProgress(0, 0).fraction).toBe(0);
  });

  it('tooltipPlacement sits below, flips above near the bottom and clamps the sides', () => {
    const tip = { w: 120, h: 60 };
    const box = { w: 600, h: 300 };
    expect(tooltipPlacement({ x: 300, y: 50 }, tip, box)).toEqual({ left: 240, top: 90 });
    expect(tooltipPlacement({ x: 300, y: 280 }, tip, box).top).toBe(180);
    expect(tooltipPlacement({ x: 5, y: 50 }, tip, box).left).toBe(4);
    expect(tooltipPlacement({ x: 598, y: 50 }, tip, box).left).toBe(476);
  });

  it('nearestIndex snaps a pixel to its day', () => {
    expect(nearestIndex(0, 0, 100, 5)).toBe(0);
    expect(nearestIndex(100, 0, 100, 5)).toBe(4);
    expect(nearestIndex(49, 0, 100, 5)).toBe(2);
    expect(nearestIndex(10, 0, 100, 1)).toBe(0);
  });
});

describe('niceTicks', () => {
  it('covers the range with round steps and always includes zero', () => {
    const t = niceTicks(-8200, 37500, 5);
    expect(t).toContain(0);
    expect(t[0]).toBeLessThanOrEqual(0);
    expect(t.at(-1)).toBeGreaterThanOrEqual(35000);
    const steps = t.slice(1).map((v, i) => v - (t[i] as number));
    expect(new Set(steps).size).toBe(1);
  });

  it('handles an all-zero range', () => {
    expect(niceTicks(0, 0)).toContain(0);
  });
});
