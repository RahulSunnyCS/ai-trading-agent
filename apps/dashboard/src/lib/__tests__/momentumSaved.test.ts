import { describe, expect, it } from 'vitest';

import type { ResultChange, SavedStrategy } from '../../types/momentum';
import {
  asSavedRun,
  autoName,
  cagrMove,
  changeSentence,
  extendedKpis,
  extendedSentence,
  matchesStrategy,
  saveToast,
  shortVersion,
  strategyCounts,
  strategyDifferences,
  strategyName,
  universeTag,
} from '../momentumSaved';

const BROAD_DEFAULTS = {
  start: '2017-01-01',
  broad_liquidity_filter: true,
  broad_respect_circuits: true,
  broad_off_top_n: 10,
  top_n: 5,
};

function strategy(patch: Partial<SavedStrategy> = {}): SavedStrategy {
  return {
    id: 'a1',
    version_id: 'momentum:broad:x',
    dataset: 'broad',
    fingerprint: 'x',
    name: 'Run 149',
    name_typed: false,
    notes: null,
    config: { ...BROAD_DEFAULTS, broad_liquidity_filter: false },
    config_full: { ...BROAD_DEFAULTS, broad_liquidity_filter: false },
    favorite: false,
    active: false,
    status: null,
    group: null,
    member_of: null,
    overlay: false,
    runs: 2,
    repeats: 0,
    first_saved: '2026-10-05T19:22:00+0530',
    last_run: '2026-10-07T22:22:00+0530',
    latest: {
      id: 'r2',
      created_at: '2026-10-07T22:22:00+0530',
      kpis: { cagr: 0.528 },
      dates: ['2026-09-25', '2026-10-02'],
      strategy: [100, 101],
      data_through: '2026-10-02',
      versions: null,
      outcome: 'new_result',
    },
    change: null,
    unreviewed: 0,
    trust: 'not_tradable',
    ...patch,
  };
}

function change(patch: Partial<ResultChange> = {}): ResultChange {
  return {
    change_id: 'c1',
    created_at: '2026-10-07T22:22:00+0530',
    dataset: 'broad',
    version_id: 'momentum:broad:x',
    anchor_run_id: 'a1',
    prev_run_id: 'r1',
    run_id: 'r2',
    label: 'data_revised',
    prev_versions: null,
    versions: null,
    changed: ['corporate_actions'],
    first_difference: '2017-08-04',
    kpis_before: { cagr: 0.532 },
    kpis_after: { cagr: 0.528 },
    detail: null,
    reviewed_at: null,
    reviewed_by: null,
    needs_review: false,
    ...patch,
  };
}

describe('strategy names', () => {
  it('lists only what differs from the defaults, ignoring what the dataset never reads', () => {
    const differences = strategyDifferences(
      { start: '2017-01-01', broad_liquidity_filter: false, top_n: 9, universe: ['x'] },
      BROAD_DEFAULTS,
      ['top_n'],
    );
    expect(differences.map((d) => d.key)).toEqual(['broad_liquidity_filter']);
    expect(differences[0]?.values).toEqual(['Off', 'On']);
  });

  it('ignores weights that do nothing: equal ones, or any under a score that never reads them', () => {
    const base = { score: 'ranksum', lookbacks: [13, 26, 52] };
    expect(strategyDifferences({ ...base, weights: [1, 1, 1] }, base)).toEqual([]);
    expect(
      strategyDifferences({ ...base, score: 'voladj', weights: [3, 2, 1] }, base).map((d) => d.key),
    ).toEqual(['score']);
    expect(strategyDifferences({ ...base, weights: [3, 2, 1] }, base).map((d) => d.key)).toEqual([
      'weights',
    ]);
  });

  it('counts a setting the strategy never stored as the default', () => {
    expect(strategyDifferences({ start: '2017-01-01' }, BROAD_DEFAULTS)).toEqual([]);
  });

  it('names a strategy by its dataset and up to three differences', () => {
    expect(autoName('broad', [])).toBe('Broad · defaults');
    const many = ['a', 'b', 'c', 'd'].map((key) => ({
      key,
      label: key.toUpperCase(),
      values: ['1', '0'],
    }));
    expect(autoName('etf', many)).toBe('ETF · A 1 · B 1 · C 1 +1');
  });

  it('keeps a typed name and names a placeholder once the defaults are known', () => {
    expect(strategyName(strategy({ name_typed: true, name: 'Mine' }), BROAD_DEFAULTS)).toBe('Mine');
    expect(strategyName(strategy(), undefined)).toBe('Run 149');
    expect(strategyName(strategy(), BROAD_DEFAULTS)).toBe('Broad · Tradability filter Off');
  });
});

describe('why it moved', () => {
  it('gives the CAGR move as a fraction', () => {
    expect(cagrMove(change())).toBeCloseTo(-0.004);
    expect(cagrMove(change({ kpis_before: {} }))).toBeNull();
  });

  it('says what changed in one sentence', () => {
    expect(changeSentence(change())).toContain('corporate_actions changed');
    expect(changeSentence(change({ label: 'intended', detail: { reason: 'Fix E12' } }))).toContain(
      '"Fix E12"',
    );
    expect(changeSentence(change({ label: 'not_reproducible' }))).toContain('a bug');
  });

  it('shortens versions and keeps a dirty marker', () => {
    expect(shortVersion('0123456789abcdef')).toBe('0123456');
    expect(shortVersion('0123456789abcdef+dirty')).toBe('0123456 +dirty');
    expect(shortVersion(null)).toBe('not recorded');
  });
});

describe('filters', () => {
  const broad = strategy();
  const paper = strategy({ id: 'b', dataset: 'etf', favorite: true, status: 'paper' });
  const watching = strategy({ id: 'c', dataset: 'etf', favorite: true, status: 'watching' });
  const list = [broad, paper, watching];

  it('filters by dataset, status and name', () => {
    expect(matchesStrategy(paper, 'ETF x', 'etf', 'paper', 'etf')).toBe(true);
    expect(matchesStrategy(broad, 'Broad', 'etf', 'any', '')).toBe(false);
    expect(matchesStrategy(broad, 'Broad', 'all', 'favourites', '')).toBe(false);
    expect(matchesStrategy(watching, 'ETF', 'all', 'favourites', 'zzz')).toBe(false);
  });

  it('counts strategies per filter', () => {
    const counts = strategyCounts(list);
    expect(counts.dataset).toMatchObject({ all: 3, etf: 2, broad: 1 });
    expect(counts.status).toMatchObject({ favourites: 2, paper: 1, watching: 1 });
  });

  it('shapes a strategy like a saved run for sorting and Compare', () => {
    const run = asSavedRun(strategy(), 'Shown');
    expect(run).toMatchObject({ id: 'a1', name: 'Shown', kpis: { cagr: 0.528 } });
    expect(run.config.dataset).toBe('broad');
  });
});

describe('the toast after saving', () => {
  const saved = {
    ...asSavedRun(strategy(), 'Run 163'),
    strategy_ref: { id: 'a1', name: 'Run 151', name_typed: false, favourite: false },
  };

  it('says a repeat added nothing', () => {
    expect(saveToast({ ...saved, outcome: 'repeat' })).toEqual({
      message: 'Same settings and result as a saved Broad strategy: no new strategy saved.',
      tone: 'info',
    });
  });

  it('says how far a moved result moved and why, louder for a suspicious one', () => {
    const moved = saveToast({ ...saved, outcome: 'new_result', change: change() });
    expect(moved.message).toContain('moved -0.4 pp CAGR: Data revised');
    expect(moved.tone).toBe('info');
    const bug = saveToast({
      ...saved,
      strategy_ref: { ...saved.strategy_ref, name: 'Mine', name_typed: true },
      outcome: 'new_result',
      change: change({ label: 'not_reproducible' }),
    });
    expect(bug.message).toContain('"Mine"');
    expect(bug.tone).toBe('error');
  });

  it('says a new strategy was saved', () => {
    expect(saveToast({ ...saved, outcome: 'new' }).tone).toBe('success');
  });
});

describe('universeTag', () => {
  it('names the universe of a Broad strategy, and nothing for another dataset', () => {
    const base = { config: {}, config_full: {} };
    expect(universeTag({ dataset: 'broad', ...base })).toBe("Today's list");
    expect(
      universeTag({
        dataset: 'broad',
        config: {},
        config_full: { broad_universe: 'turnover_rank' },
      }),
    ).toBe('Point in time');
    expect(
      universeTag({ dataset: 'broad', config: {}, config_full: { broad_universe: 'all_liquid' } }),
    ).toBe('Whole NSE market');
    expect(universeTag({ dataset: 'etf', ...base })).toBeNull();
  });

  it('reads the fully spelled-out config, so an old run with no stored universe is today’s list', () => {
    const old = {
      dataset: 'broad',
      config: { top_n: 5 },
      config_full: { broad_universe: 'total_market' },
    };
    expect(universeTag(old)).toBe("Today's list");
  });
});

describe('extendedKpis', () => {
  it('reads the figure saved beside a run, and is null for one saved before it existed', () => {
    expect(extendedKpis({ cagr: 0.45 })).toBeNull();
    expect(
      extendedKpis({ cagr: 0.45, extended_cagr: 0.334, extended_max_drawdown: -0.386 }),
    ).toEqual({
      cagr: 0.334,
      maxDrawdown: -0.386,
    });
    expect(extendedKpis({ extended_cagr: 0.3 })).toEqual({ cagr: 0.3, maxDrawdown: null });
  });

  it('says it in one sentence', () => {
    expect(extendedSentence({ cagr: 0.334, maxDrawdown: -0.386 })).toContain(
      'With extended tags: 33.4% CAGR',
    );
    expect(extendedSentence({ cagr: 0.334, maxDrawdown: null })).not.toContain('max DD');
  });
});
