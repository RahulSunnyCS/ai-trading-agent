import { describe, expect, it } from 'vitest';

import {
  COMPARE_METRICS,
  type ComparableRun,
  type MetricDef,
  bestRunIndex,
  completeConfig,
  defaultSortDirection,
  differingSettings,
  drawdownSeries,
  formatSettingValue,
  listSettings,
  runBenchmark,
  runPeriod,
  seriesEnds,
  settingLabel,
  sortSavedRuns,
  sparklinePath,
  toggleSelection,
} from '../momentumCompare';

function run(id: string, patch: Partial<ComparableRun> = {}): ComparableRun {
  return {
    id,
    name: id,
    n: 1,
    created_at: '2026-10-01T10:00:00+05:30',
    active: false,
    config: {},
    kpis: {},
    ...patch,
  };
}

function metric(key: string): MetricDef {
  const found = COMPARE_METRICS.find((item) => item.key === key);
  if (!found) throw new Error(`no metric ${key}`);
  return found;
}

const ids = (runs: ComparableRun[]) => runs.map((item) => item.id);

describe('sortSavedRuns', () => {
  const runs = [
    run('old', { created_at: '2026-09-01T10:00:00+05:30', kpis: { cagr: 0.3, excess_cagr: 0.1 } }),
    run('new', { created_at: '2026-10-05T10:00:00+05:30', kpis: { cagr: 0.1, excess_cagr: 0.2 } }),
    run('mid', { created_at: '2026-09-15T10:00:00+05:30', kpis: { cagr: 0.2 } }),
  ];

  it('defaults to newest first', () => {
    expect(ids(sortSavedRuns(runs))).toEqual(['new', 'mid', 'old']);
  });

  it('pins the Telegram-active run to the top whatever the sort', () => {
    const withActive = runs.map((item) => (item.id === 'old' ? { ...item, active: true } : item));
    expect(ids(sortSavedRuns(withActive))).toEqual(['old', 'new', 'mid']);
    expect(ids(sortSavedRuns(withActive, 'cagr', 'asc'))).toEqual(['old', 'new', 'mid']);
    expect(ids(sortSavedRuns(withActive, 'name', 'desc'))).toEqual(['old', 'new', 'mid']);
  });

  it('sorts by a metric in both directions', () => {
    expect(ids(sortSavedRuns(runs, 'cagr'))).toEqual(['old', 'mid', 'new']);
    expect(ids(sortSavedRuns(runs, 'cagr', 'asc'))).toEqual(['new', 'mid', 'old']);
  });

  it('sinks a run without the metric to the bottom in either direction', () => {
    expect(ids(sortSavedRuns(runs, 'excess_cagr', 'desc'))).toEqual(['new', 'old', 'mid']);
    expect(ids(sortSavedRuns(runs, 'excess_cagr', 'asc'))).toEqual(['old', 'new', 'mid']);
  });

  it('sorts names case-insensitively and does not mutate its input', () => {
    const named = [run('1', { name: 'beta' }), run('2', { name: 'Alpha' })];
    expect(ids(sortSavedRuns(named, 'name'))).toEqual(['2', '1']);
    expect(ids(named)).toEqual(['1', '2']);
  });

  it('starts each column best (or newest) first', () => {
    expect(defaultSortDirection('saved')).toBe('desc');
    expect(defaultSortDirection('excess_cagr')).toBe('desc');
    // Drawdown is stored negative: descending puts -20% above -50%.
    expect(defaultSortDirection('max_drawdown')).toBe('desc');
    expect(defaultSortDirection('turnover_per_year')).toBe('asc');
    expect(defaultSortDirection('name')).toBe('asc');
  });
});

describe('toggleSelection', () => {
  it('adds and removes', () => {
    expect(toggleSelection(['a'], 'b')).toEqual({ selected: ['a', 'b'], refused: false });
    expect(toggleSelection(['a', 'b'], 'a')).toEqual({ selected: ['b'], refused: false });
  });

  it('refuses a fifth run and leaves the selection alone', () => {
    const four = ['a', 'b', 'c', 'd'];
    const result = toggleSelection(four, 'e');
    expect(result.refused).toBe(true);
    expect(result.selected).toBe(four);
    // Unticking still works at the limit.
    expect(toggleSelection(four, 'd').selected).toEqual(['a', 'b', 'c']);
  });
});

describe('bestRunIndex', () => {
  const runs = [
    run('a', { kpis: { cagr: 0.2, max_drawdown: -0.4, turnover_per_year: 3, avg_holdings: 5 } }),
    run('b', { kpis: { cagr: 0.3, max_drawdown: -0.2, turnover_per_year: 6, avg_holdings: 9 } }),
    run('c', { kpis: { cagr: null } }),
  ];

  it('picks the highest CAGR, the shallowest drawdown and the lowest turnover', () => {
    expect(bestRunIndex(runs, metric('cagr'))).toBe(1);
    expect(bestRunIndex(runs, metric('max_drawdown'))).toBe(1);
    expect(bestRunIndex(runs, metric('turnover_per_year'))).toBe(0);
  });

  it('marks nothing for a metric with no better end, a lone value or a tie', () => {
    expect(bestRunIndex(runs, metric('avg_holdings'))).toBeNull();
    expect(
      bestRunIndex([runs[0] as ComparableRun, runs[2] as ComparableRun], metric('cagr')),
    ).toBeNull();
    expect(
      bestRunIndex(
        [run('x', { kpis: { cagr: 0.1 } }), run('y', { kpis: { cagr: 0.1 } })],
        metric('cagr'),
      ),
    ).toBeNull();
  });
});

describe('period and benchmark', () => {
  it('formats the saved days and falls back to "latest"', () => {
    expect(runPeriod({ start: '2017-01-06', end: '2026-08-25' })).toBe('06 Jan 2017 → 25 Aug 2026');
    expect(runPeriod({ start: '2017-01-06', end: null })).toBe('06 Jan 2017 → latest');
    expect(runPeriod({})).toBe('— → latest');
  });

  it('reads the benchmark', () => {
    expect(runBenchmark({ benchmark: 'Nifty 50 TRI' })).toBe('Nifty 50 TRI');
    expect(runBenchmark({})).toBe('—');
  });
});

describe('settings labels and values', () => {
  it('uses the settings-panel words and humanises an unknown key', () => {
    expect(settingLabel('broad_category_top_n')).toBe('Categories held');
    expect(settingLabel('exit_rank')).toBe('Sell when rank >');
    expect(settingLabel('some_new_knob')).toBe('Some new knob');
  });

  it('formats values by kind', () => {
    expect(formatSettingValue(true)).toBe('On');
    expect(formatSettingValue(null)).toBe('—');
    expect(formatSettingValue([13, 26, 52], 'lookbacks')).toBe('13, 26, 52');
    expect(formatSettingValue(1000000.0, 'capital')).toBe('10,00,000');
    expect(formatSettingValue(0.2, 'max_position')).toBe('20%');
    expect(formatSettingValue(0.1836, 'broad_coverage_floor')).toBe('18.36%');
    expect(formatSettingValue('voladj', 'score')).toBe('Volatility-adjusted');
    expect(formatSettingValue('2017-01-01', 'start')).toBe('01 Jan 2017');
    expect(formatSettingValue(3, 'rebalance_offset')).toBe('Phase 4');
  });

  it('lists a config in settings-panel order', () => {
    expect(listSettings({ zzz: 1, top_n: 5, start: '2017-01-01' }).map((row) => row.key)).toEqual([
      'start',
      'top_n',
      'zzz',
    ]);
  });
});

describe('differingSettings', () => {
  it('covers the union of keys, not only the first run’s', () => {
    const diff = differingSettings([
      { top_n: 5, exit_rank: 10 },
      { top_n: 5, exit_rank: 10, broad_category_tags: 'curated' },
    ]);
    expect(diff).toEqual([
      {
        key: 'broad_category_tags',
        label: 'Category tags',
        values: ['—', "Today's list tags (curated)"],
      },
    ]);
  });

  it('treats 15 and 15.0, reordered objects and null/missing as equal', () => {
    expect(
      differingSettings([
        { slippage_bps: 15, extra: { a: 1, b: 2 }, max_category: null },
        { slippage_bps: 15.0, extra: { b: 2, a: 1 } },
      ]),
    ).toEqual([]);
  });

  it('gives one value per run across more than two runs', () => {
    const diff = differingSettings([{ top_n: 5 }, { top_n: 10 }, { top_n: 5 }, {}]);
    expect(diff).toEqual([{ key: 'top_n', label: 'Top N', values: ['5', '10', '5', '—'] }]);
  });

  it('needs two configs', () => {
    expect(differingSettings([{ top_n: 5 }])).toEqual([]);
  });
});

describe('completeConfig', () => {
  it('fills what the saved run lacks from the defaults and lets the saved value win', () => {
    expect(completeConfig({ tax: false, top_n: 5, sell_every_week: false }, { top_n: 10 })).toEqual(
      {
        tax: false,
        top_n: 10,
        sell_every_week: false,
      },
    );
  });
});

describe('series helpers', () => {
  it('draws a path across the whole box', () => {
    expect(sparklinePath([1, 2, 3], 100, 20)).toBe('M0,19 L50,10 L100,1');
  });

  it('thins a long series but keeps its last point', () => {
    const values = Array.from({ length: 509 }, (_, i) => i);
    const path = sparklinePath(values, 100, 20, 60) ?? '';
    const segments = path.split(' ');
    expect(segments.length).toBeLessThanOrEqual(61);
    expect(segments[segments.length - 1]).toBe('L100,1');
  });

  it('skips gaps, draws a flat line mid-height and refuses a single point', () => {
    expect(sparklinePath([1, null, 3], 10, 20)).toBe('M0,19 L10,1');
    expect(sparklinePath([5, 5], 10, 20)).toBe('M0,10 L10,10');
    expect(sparklinePath([5], 10, 20)).toBeNull();
    expect(sparklinePath([], 10, 20)).toBeNull();
  });

  it('reads the ends of a series', () => {
    expect(seriesEnds([null, 100, 150, null])).toEqual({ first: 100, last: 150 });
    expect(seriesEnds([100])).toBeNull();
  });

  it('computes drawdown from the running peak', () => {
    expect(drawdownSeries([100, 120, 90, null, 150])).toEqual([0, 0, -0.25, null, 0]);
  });
});

describe('universe labels', () => {
  it('spells all three Broad universes, including the point-in-time one', () => {
    const diff = differingSettings([
      { broad_universe: 'turnover_rank' },
      { broad_universe: 'total_market' },
      { broad_universe: 'all_liquid' },
    ]);
    expect(diff).toEqual([
      {
        key: 'broad_universe',
        label: 'Broad universe',
        values: [
          'As each year saw it',
          "Today's index list (survivors only)",
          'Whole NSE market (liquid only)',
        ],
      },
    ]);
  });
});
