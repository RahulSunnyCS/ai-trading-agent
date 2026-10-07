import { describe, expect, it } from 'vitest';

import type { MomentumResult, MomentumSeries } from '../../types/momentum';
import {
  DEFAULT_BENCHMARK,
  aheadShare,
  benchmarkLabel,
  benchmarkOptions,
  changeBetween,
  drawdownSeries,
  resolveBenchmark,
  rolling52Excess,
  trailingReturn,
  withBenchmark,
  worstEpisodes,
  yearToDate,
  yearlyRows,
} from '../momentumBenchmark';

const series: MomentumSeries = {
  dates: ['2023-12-22', '2023-12-29', '2024-01-05', '2024-12-27', '2025-01-03'],
  strategy: [100, 110, 121, 132, 145.2],
  benchmark: [100, 100, 100, 100, 100],
  cash: [100, 100, 100, 100, 100],
  drawdown_strategy: [0, 0, 0, 0, 0],
  drawdown_benchmark: [0, 0, 0, 0, 0],
  rolling_52w_excess: [null, null, null, null, null],
  idle_share: [0, 0, 0, 0, 0],
  holdings_count: [1, 1, 1, 1, 1],
};

function result(extra: Partial<MomentumResult> = {}): MomentumResult {
  return {
    benchmark_name: 'Nifty 50',
    kpis: {
      benchmark_cagr: 0.1,
      excess_cagr: 0.05,
      benchmark_max_drawdown: -0.3,
      benchmark_final_value: 200000,
      years_beating_benchmark: 3,
    },
    series,
    rotations: [],
    open_positions: [],
    yearly: [],
    crashes: [],
    ...extra,
  };
}

const mom = {
  name: DEFAULT_BENCHMARK,
  available: true as const,
  as_of: '2024-12-27',
  note: null,
  series: [100, 90, 99, 120, 150],
  cagr: 0.18,
  excess_cagr: 0.06,
  total_return: 0.5,
  final_value: 150,
  volatility: 0.2,
  sharpe: 0.9,
  sortino: 1.2,
  max_drawdown: -0.1,
  max_drawdown_trough: '2023-12-29',
  years_beating: 1,
};

describe('benchmarkLabel', () => {
  it.each([
    ['Nifty200 Momentum 30 TRI', 'Nifty 200 Momentum 30'],
    ['Nifty 50 TRI', 'Nifty 50'],
    ['Nifty Midcap 150 TRI', 'Nifty Midcap 150'],
    ['Nifty 50', 'Nifty 50'],
  ])('%s -> %s', (name, label) => expect(benchmarkLabel(name)).toBe(label));
});

describe('resolveBenchmark', () => {
  it('uses the picked index with its server statistics', () => {
    const view = resolveBenchmark(result({ benchmarks: [mom] }), DEFAULT_BENCHMARK);
    expect(view).toMatchObject({
      label: 'Nifty 200 Momentum 30',
      cagr: 0.18,
      sharpe: 0.9,
      fallback: false,
      // The last real close is a week before the final week: say so.
      asOf: '2024-12-27',
    });
  });

  it("falls back to the run's own benchmark for an older result or an index without data", () => {
    for (const r of [
      result(),
      result({ benchmarks: [{ name: DEFAULT_BENCHMARK, available: false }] }),
    ]) {
      const view = resolveBenchmark(r, DEFAULT_BENCHMARK);
      expect(view).toMatchObject({ name: 'Nifty 50', cagr: 0.1, fallback: true, sharpe: null });
      expect(view.values).toBe(series.benchmark);
    }
  });

  it('lists the options in order, with availability', () => {
    expect(
      benchmarkOptions(
        result({ benchmarks: [mom, { name: 'Nifty Next 50 TRI', available: false }] }),
      ),
    ).toEqual([
      {
        name: DEFAULT_BENCHMARK,
        label: 'Nifty 200 Momentum 30',
        available: true,
        cagr: 0.18,
        reason: null,
      },
      {
        name: 'Nifty Next 50 TRI',
        label: 'Nifty Next 50',
        available: false,
        cagr: null,
        reason: 'No data for this run',
      },
    ]);
  });

  it("carries the server's reason for an index it could not use", () => {
    const options = benchmarkOptions(
      result({
        benchmarks: [
          mom,
          {
            name: 'Nifty Smallcap 250 TRI',
            available: false,
            reason: "Starts 05 Jan 2024, after this run's first week",
          },
        ],
      }),
    );
    expect(options[1]).toMatchObject({
      available: false,
      reason: "Starts 05 Jan 2024, after this run's first week",
    });
  });

  it("refuses a curve that does not match the run's weeks, instead of drawing it truncated", () => {
    const short = { ...mom, series: [100, 90, 99] };
    const r = result({ benchmarks: [short] });
    expect(benchmarkOptions(r)[0]).toMatchObject({
      available: false,
      reason: "Does not match this run's weeks",
    });
    const view = resolveBenchmark(r, DEFAULT_BENCHMARK);
    expect(view.fallback).toBe(true);
    expect(view.replaced).toEqual({
      label: 'Nifty 200 Momentum 30',
      reason: "Does not match this run's weeks",
    });
  });
});

describe('a pick that cannot be used', () => {
  it("says which index was asked for and why the run's own benchmark is shown", () => {
    const r = result({
      benchmarks: [
        mom,
        { name: 'Nifty 50 TRI', available: false, reason: 'No data for this index' },
      ],
    });
    const view = resolveBenchmark(r, 'Nifty 50 TRI');
    expect(view).toMatchObject({ fallback: true, label: 'Nifty 50', name: 'Nifty 50' });
    expect(view.replaced).toEqual({ label: 'Nifty 50', reason: 'No data for this index' });
  });

  it('names a pick the run does not offer at all', () => {
    const r = result({ benchmarks: [mom] });
    expect(resolveBenchmark(r, 'Nifty Smallcap 250 TRI').replaced).toEqual({
      label: 'Nifty Smallcap 250',
      reason: 'Not offered for this run',
    });
  });

  it('is silent for an older result with no picker at all', () => {
    expect(resolveBenchmark(result(), DEFAULT_BENCHMARK).replaced).toBeNull();
  });

  it('is not a replacement when the pick is used', () => {
    expect(resolveBenchmark(result({ benchmarks: [mom] }), DEFAULT_BENCHMARK).replaced).toBeNull();
  });
});

describe('switching the benchmark changes everything derived from it', () => {
  const other = { ...mom, name: 'Nifty 50 TRI', series: [100, 105, 110, 115, 120], cagr: 0.1 };
  const r = result({ benchmarks: [mom, other] });
  const a = withBenchmark(series, resolveBenchmark(r, DEFAULT_BENCHMARK));
  const b = withBenchmark(series, resolveBenchmark(r, 'Nifty 50 TRI'));

  it('swaps the curve, its drawdown and the 52-week edge', () => {
    expect(a.benchmark).toEqual(mom.series);
    expect(b.benchmark).toEqual(other.series);
    expect(a.drawdown_benchmark).not.toEqual(b.drawdown_benchmark);
    expect(a.benchmark).not.toEqual(series.benchmark);
    expect(b.benchmark).not.toEqual(series.benchmark);
  });

  it('changes the yearly rows and the worst falls', () => {
    const yearlyA = yearlyRows(a);
    const yearlyB = yearlyRows(b);
    expect(yearlyA.map((row) => row.benchmark)).not.toEqual(yearlyB.map((row) => row.benchmark));
    expect(worstEpisodes(a.benchmark)).toHaveLength(1);
    expect(worstEpisodes(b.benchmark)).toHaveLength(0);
  });
});

describe('aheadShare', () => {
  it('is the share of known weeks the strategy was ahead', () => {
    expect(aheadShare([null, 0.1, -0.1, 0.2, 0])).toBeCloseTo(0.5);
  });
  it('is null when nothing is known', () => {
    expect(aheadShare([null, null])).toBeNull();
    expect(aheadShare([])).toBeNull();
  });
});

describe('a benchmark that starts late or has gaps', () => {
  it('keeps nulls as nulls instead of NaN or Infinity', () => {
    const late = [null, null, 100, 110, 99];
    expect(drawdownSeries(late)).toEqual([null, null, 0, 0, expect.closeTo(-0.1)]);
    const edge = rolling52Excess(late, late, 2);
    expect(edge.every((value) => value === null || Number.isFinite(value))).toBe(true);
    expect(trailingReturn(late, 4)).toBeNull();
  });
  it('treats a zero or negative level as unknown', () => {
    expect(drawdownSeries([0, 100, -5])).toEqual([null, 0, expect.any(Number)]);
    expect(rolling52Excess([100, 110, 120], [0, 100, 110], 1)[1]).toBeNull();
  });
});

describe('derived series', () => {
  it('computes drawdown against the running peak, skipping gaps', () => {
    expect(drawdownSeries([100, 80, null, 120, 90])).toEqual([
      0,
      expect.closeTo(-0.2),
      null,
      0,
      expect.closeTo(-0.25),
    ]);
  });

  it('computes the 52-week edge', () => {
    const out = rolling52Excess([1, 1.5, 2], [1, 1.2, 1.1], 1);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(0.3);
    expect(out[2]).toBeCloseTo(2 / 1.5 - 1.1 / 1.2);
  });

  it('swaps the benchmark into the series, leaving a fallback untouched', () => {
    const view = resolveBenchmark(result({ benchmarks: [mom] }), DEFAULT_BENCHMARK);
    const swapped = withBenchmark(series, view);
    expect(swapped.benchmark).toBe(mom.series);
    expect(swapped.drawdown_benchmark[1]).toBeCloseTo(-0.1);
    const own = resolveBenchmark(result(), DEFAULT_BENCHMARK);
    expect(withBenchmark(series, own)).toBe(series);
  });

  it('measures the last N weeks and the year to date', () => {
    expect(trailingReturn(series.strategy, 2)).toBeCloseTo(145.2 / 121 - 1);
    expect(trailingReturn(series.strategy, 10)).toBeNull();
    expect(yearToDate(series.dates, series.strategy)).toBeCloseTo(145.2 / 132 - 1);
  });

  it('computes calendar-year returns from year end to year end', () => {
    const rows = yearlyRows(series);
    expect(rows.map((row) => row.year)).toEqual([2023, 2024, 2025]);
    expect(rows[0]?.strategy).toBeCloseTo(0.1);
    expect(rows[1]?.strategy).toBeCloseTo(0.2);
    expect(rows[1]?.vs_benchmark).toBeCloseTo(0.2);
  });

  it('finds non-overlapping falls, deepest first, with recovery', () => {
    const values = [100, 90, 100, 120, 60, 80, 130, 125];
    const episodes = worstEpisodes(values, 3);
    expect(episodes).toEqual([
      { peak: 3, trough: 4, recovered: 6, depth: -0.5 },
      { peak: 0, trough: 1, recovered: 2, depth: expect.closeTo(-0.1) },
      { peak: 6, trough: 7, recovered: null, depth: expect.closeTo(-5 / 130) },
    ]);
    expect(changeBetween(values, 3, 4)).toBeCloseTo(-0.5);
  });
});
