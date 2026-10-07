import { describe, expect, it } from 'vitest';

import {
  MOMENTUM_SETTING_LABELS,
  describeConfig,
  diffConfigs,
  hindsightWarning,
  modifiedSections,
  settingsSectionOf,
} from '../momentumConfig';

const BASE = {
  start: '2017-01-06',
  end: '2026-09-25',
  benchmark: 'Nifty 500',
  top_n: 5,
  exit_rank: 10,
};

describe('describeConfig', () => {
  it('describes an ETF config from top_n / exit_rank', () => {
    expect(
      describeConfig({ ...BASE, rebalance: 'weekly', rebalance_every: 1 }, 'etf'),
    ).toMatchObject({
      period: '2017-01-06 → 2026-09-25',
      cadence: 'weekly',
      cadenceChip: 'Weekly rebalance',
      selection: 'top 5, exit after rank 10',
      selectionShort: 'top 5 / exit >10',
      benchmark: 'Nifty 500',
    });
  });

  it.each([
    [2, 0, 'every 2 weeks', 'Every 2 weeks (phase 1)'],
    [4, 3, 'every 4 weeks', 'Every 4 weeks (phase 4)'],
  ])('names an every-%i-week cadence instead of "weekly"', (every, offset, cadence, chip) => {
    const d = describeConfig(
      { ...BASE, rebalance: 'weekly', rebalance_every: every, rebalance_offset: offset },
      'etf',
    );
    expect(d.cadence).toBe(cadence);
    expect(d.cadenceChip).toBe(chip);
  });

  it('monthly wins over a leftover rebalance_every', () => {
    const d = describeConfig({ ...BASE, rebalance: 'monthly', rebalance_every: 4 }, 'etf');
    expect(d.cadence).toBe('monthly');
    expect(d.cadenceChip).toBe('Monthly rebalance');
  });

  it('Broad with categories ignores top_n / exit_rank and uses the category keys', () => {
    const d = describeConfig(
      {
        ...BASE,
        broad_category_mode: 'on',
        broad_category_top_n: 4,
        broad_category_exit_rank: 8,
        broad_picks_per_category: 2,
        broad_off_top_n: 10,
        broad_off_exit_rank: 20,
      },
      'broad',
    );
    expect(d.selection).toBe('top 4 categories × 2 stocks each, sell a category after rank 8');
    expect(d.selectionShort).toBe('top 4 categories × 2 / exit >8');
  });

  it('Broad without categories uses the broad_off keys', () => {
    const d = describeConfig(
      { ...BASE, broad_category_mode: 'off', broad_off_top_n: 10, broad_off_exit_rank: 20 },
      'broad',
    );
    expect(d.selection).toBe('top 10 stocks, exit after rank 20');
    expect(d.selectionShort).toBe('top 10 stocks / exit >20');
  });

  it('prints an em dash rather than a made-up number for a missing value', () => {
    const d = describeConfig({}, 'stock');
    expect(d).toMatchObject({
      period: 'Start → latest',
      cadence: 'weekly',
      selection: 'top —, exit after rank —',
      benchmark: '—',
    });
  });
});

describe('describeConfig chips', () => {
  const pairs = (config: Record<string, unknown>, dataset: string) =>
    describeConfig(config, dataset).chips.map((chip) => [chip.id, chip.label, chip.section]);

  it('lists an ETF config in reading order, each chip naming its accordion', () => {
    expect(
      pairs(
        {
          ...BASE,
          universe: ['A', 'B', 'C'],
          rebalance: 'weekly',
          rebalance_every: 1,
          portfolio: 'buffer',
          cost_model: 'flat',
          cost_pct: 0.1,
          tax: false,
        },
        'etf',
      ),
    ).toEqual([
      ['period', '2017-01-06 → 2026-09-25', 'period'],
      ['universe', '3 ETFs', 'universe'],
      ['selection', 'top 5 / exit >10', 'portfolio'],
      ['cadence', 'Weekly rebalance', 'portfolio'],
      ['portfolio', 'Buffer rule', 'portfolio'],
      ['costs', '0.1% cost per side', 'costs'],
      ['tax', 'Pre-tax', 'costs'],
    ]);
  });

  it('Broad with categories points selection at the Selection accordion and has no tax chip', () => {
    const chips = pairs(
      {
        ...BASE,
        universe: ['broad_momentum'],
        broad_universe: 'all_liquid',
        broad_liq_min_turnover_cr: 2,
        broad_category_mode: 'on',
        broad_category_top_n: 4,
        broad_category_exit_rank: 8,
        broad_picks_per_category: 2,
        portfolio: 'slots',
        cost_model: 'itemised',
      },
      'broad',
    );
    expect(chips).toEqual([
      ['period', '2017-01-06 → 2026-09-25', 'period'],
      ['universe', 'Whole NSE market · ≥ ₹2 Cr/day', 'universe'],
      ['selection', 'top 4 categories × 2 / exit >8', 'selection'],
      ['cadence', 'Weekly rebalance', 'portfolio'],
      ['portfolio', 'Fixed slots', 'portfolio'],
      ['costs', 'Itemised costs', 'costs'],
    ]);
  });

  it('Broad without categories uses the stock keys and names the plain pool', () => {
    const chips = pairs(
      {
        ...BASE,
        broad_universe: 'total_market',
        broad_liquidity_filter: false,
        broad_category_mode: 'off',
        broad_off_top_n: 10,
        broad_off_exit_rank: 20,
      },
      'broad',
    );
    expect(chips[1]).toEqual(['universe', 'Nifty Total Market', 'universe']);
    expect(chips[2]).toEqual(['selection', 'top 10 stocks / exit >20', 'selection']);
  });

  it('names an every-N cadence, with its phase, in the cadence chip', () => {
    const chips = pairs(
      { ...BASE, rebalance: 'weekly', rebalance_every: 4, rebalance_offset: 2 },
      'etf',
    );
    expect(chips.find(([id]) => id === 'cadence')).toEqual([
      'cadence',
      'Every 4 weeks (phase 3)',
      'portfolio',
    ]);
  });

  it('agrees with the sentence fields it replaces', () => {
    const d = describeConfig({ ...BASE, rebalance: 'monthly' }, 'etf');
    const label = (id: string) => d.chips.find((chip) => chip.id === id)?.label;
    expect(label('period')).toBe(d.period);
    expect(label('selection')).toBe(d.selectionShort);
    expect(label('cadence')).toBe(d.cadenceChip);
    // The benchmark is picked on the result (the headline picker), not in the settings.
    expect(label('benchmark')).toBeUndefined();
  });
});

describe('settingsSectionOf', () => {
  it('puts the dates with the period, and the engine benchmark nowhere (the picker owns it)', () => {
    expect(settingsSectionOf('benchmark', 'etf')).toBeNull();
    expect(settingsSectionOf('start', 'broad')).toBe('period');
  });

  it('returns null for a key the dataset ignores', () => {
    expect(settingsSectionOf('top_n', 'broad')).toBeNull();
    expect(settingsSectionOf('top_n', 'etf')).toBe('portfolio');
    expect(settingsSectionOf('broad_off_top_n', 'etf')).toBeNull();
    expect(settingsSectionOf('broad_off_top_n', 'broad')).toBe('selection');
    expect(settingsSectionOf('tax', 'broad')).toBeNull();
    expect(settingsSectionOf('not_a_setting', 'etf')).toBeNull();
  });
});

describe('modifiedSections', () => {
  const DEFAULTS = {
    ...BASE,
    universe: ['A', 'B'],
    lookbacks: [1, 4, 13],
    weights: [1, 1, 1],
    portfolio: 'buffer',
    rebalance: 'weekly',
    rebalance_every: 1,
    max_position: 0.35,
    cost_pct: 0.1,
    broad_category_mode: 'on',
    broad_category_top_n: 4,
    broad_off_top_n: 10,
    broad_pool_top_n: 200,
  };

  it('is empty when nothing differs, whatever the universe order', () => {
    expect([...modifiedSections({ ...DEFAULTS, universe: ['B', 'A'] }, DEFAULTS, 'etf')]).toEqual(
      [],
    );
  });

  it('marks each accordion holding a changed setting', () => {
    const modified = modifiedSections(
      {
        ...DEFAULTS,
        universe: ['A'],
        benchmark: 'Nifty 50',
        weights: [1, 2, 1],
        top_n: 8,
        max_position: null,
        cost_pct: 0.2,
      },
      DEFAULTS,
      'etf',
    );
    // The engine benchmark is not a setting any more: it marks no section.
    expect([...modified].sort()).toEqual(['costs', 'limits', 'portfolio', 'ranking', 'universe']);
  });

  it('ignores keys the dataset does not use', () => {
    // ETF ignores the broad_* keys; Broad ignores top_n / exit_rank and the instrument list.
    expect([...modifiedSections({ ...DEFAULTS, broad_pool_top_n: 300 }, DEFAULTS, 'etf')]).toEqual(
      [],
    );
    expect([
      ...modifiedSections({ ...DEFAULTS, top_n: 9, universe: ['x'] }, DEFAULTS, 'broad'),
    ]).toEqual([]);
    expect([
      ...modifiedSections({ ...DEFAULTS, broad_pool_top_n: 300 }, DEFAULTS, 'broad'),
    ]).toEqual(['universe']);
  });

  it('ignores the Broad selection fields the current category mode hides', () => {
    expect([...modifiedSections({ ...DEFAULTS, broad_off_top_n: 15 }, DEFAULTS, 'broad')]).toEqual(
      [],
    );
    expect([
      ...modifiedSections(
        { ...DEFAULTS, broad_category_mode: 'off', broad_off_top_n: 15, broad_category_top_n: 6 },
        DEFAULTS,
        'broad',
      ),
    ]).toEqual(['selection']);
  });
});

describe('diffConfigs', () => {
  const RUN = {
    ...BASE,
    dataset: 'etf',
    universe: ['A', 'B'],
    lookbacks: [1, 4, 13],
    max_position: 0.35,
    tax: false,
    broad_pool_top_n: 200,
  };

  it('is empty for identical configs', () => {
    expect(diffConfigs(RUN, { ...RUN })).toEqual([]);
  });

  it("lists changes with the settings panel's labels", () => {
    expect(
      diffConfigs(RUN, {
        ...RUN,
        top_n: 8,
        max_position: 0.4,
        tax: true,
        lookbacks: [4, 13],
        benchmark: 'Nifty 50',
      }),
    ).toEqual([
      // No "Benchmark" line: the headline picker owns the comparison.
      'Lookbacks (weeks) 1/4/13 → 4/13',
      'Top N 5 → 8',
      'Max per holding 35% → 40%',
      'Apply capital-gains tax off → on',
    ]);
    expect(MOMENTUM_SETTING_LABELS.top_n).toBe('Top N');
  });

  it('summarises a universe change by count', () => {
    expect(diffConfigs(RUN, { ...RUN, universe: ['B', 'C', 'D'] })).toEqual([
      'Universe 2 → 3 (+2 / −1)',
    ]);
  });

  it('skips keys the dataset ignores and shows unknown keys raw', () => {
    expect(diffConfigs(RUN, { ...RUN, broad_pool_top_n: 300, mystery: 2 })).toEqual([
      'mystery none → 2',
    ]);
  });

  it('reports a dataset change on its own', () => {
    expect(diffConfigs(RUN, { ...RUN, dataset: 'broad', top_n: 9 })).toEqual([
      'Dataset etf → broad',
    ]);
  });

  it('shows a cleared cap as none', () => {
    expect(diffConfigs(RUN, { ...RUN, max_position: null })).toEqual([
      'Max per holding 35% → none',
    ]);
  });
});

describe('hindsightWarning', () => {
  it('warns on Broad and names the realism switches left off', () => {
    const w = hindsightWarning({ dataset: 'broad' });
    expect(w?.headline).toMatch(/upper bound/);
    expect(w?.realismOff).toEqual(['circuit locks', 'the tradability filter']);
  });

  it('lists nothing extra when both Broad switches are on', () => {
    const w = hindsightWarning({
      dataset: 'broad',
      broad_respect_circuits: true,
      broad_liquidity_filter: true,
    });
    expect(w?.realismOff).toEqual([]);
  });

  it('counts the whole-market universe as filtered (the gate is mandatory there)', () => {
    const w = hindsightWarning({
      dataset: 'broad',
      broad_respect_circuits: true,
      broad_universe: 'all_liquid',
    });
    expect(w?.realismOff).toEqual([]);
  });

  it('warns on Custom Index, and not on ETF Rotation or the Nifty 50 stock set', () => {
    expect(hindsightWarning({ dataset: 'custom_index' })).not.toBeNull();
    expect(hindsightWarning({ dataset: 'etf' })).toBeNull();
    expect(hindsightWarning({ dataset: 'stock' })).toBeNull();
  });
});
