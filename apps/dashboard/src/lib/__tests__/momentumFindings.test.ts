import { describe, expect, it } from 'vitest';

import type { ResultChange, SavedStrategy } from '../../types/momentum';
import { MAX_FINDINGS, savedFindings, tradableTwin } from '../momentumFindings';

const BASE = {
  start: '2017-01-01',
  broad_off_top_n: 10,
  broad_liquidity_filter: true,
  broad_respect_circuits: true,
};

function strategy(id: string, cagr: number, patch: Partial<SavedStrategy> = {}): SavedStrategy {
  return {
    id,
    version_id: `momentum:broad:${id}`,
    dataset: 'broad',
    fingerprint: id,
    name: id,
    name_typed: true,
    notes: null,
    config: BASE,
    config_full: BASE,
    favorite: false,
    active: false,
    status: null,
    group: null,
    member_of: null,
    overlay: false,
    runs: 1,
    repeats: 0,
    first_saved: '2026-10-05T10:00:00+0530',
    last_run: '2026-10-08T10:00:00+0530',
    latest: {
      id: `${id}-run`,
      created_at: '2026-10-08T10:00:00+0530',
      kpis: { cagr },
      dates: [],
      strategy: [],
      data_through: '2026-10-02',
      versions: null,
      outcome: 'new',
    },
    change: null,
    unreviewed: 0,
    trust: 'in_sample',
    ...patch,
  };
}

function change(label: ResultChange['label'], needsReview: boolean): ResultChange {
  return {
    change_id: `c-${label}`,
    created_at: '2026-10-08T10:00:00+0530',
    dataset: 'broad',
    version_id: 'v',
    anchor_run_id: 'a',
    prev_run_id: 'p',
    run_id: 'r',
    label,
    prev_versions: null,
    versions: null,
    changed: null,
    first_difference: '2017-08-04',
    kpis_before: { cagr: 0.532 },
    kpis_after: { cagr: 0.528 },
    detail: null,
    reviewed_at: null,
    reviewed_by: null,
    needs_review: needsReview,
  };
}

const off = { ...BASE, broad_liquidity_filter: false, broad_respect_circuits: false };
// The owner's saved strategies on 2026-10-08, cut down.
const LIVE = [
  strategy('liq-off', 0.528, {
    config_full: off,
    trust: 'not_tradable',
    runs: 2,
    latest: { ...strategy('x', 0.528).latest, outcome: 'new_result' },
    change: change('unknown', false),
  }),
  strategy('defaults', 0.413, { runs: 3, repeats: 2 }),
  strategy('phase6', 0.341, { trust: 'validated' }),
  strategy('etf', 0.254, { dataset: 'etf', runs: 9, repeats: 8 }),
  strategy('stock-core', 0.117, {
    dataset: 'stock',
    config_full: { start: '2012-01-01' },
  }),
];
const name = (s: SavedStrategy) => s.name;

describe('the tradable twin', () => {
  it('is the same Broad settings with the filter and the circuit rule on', () => {
    expect(tradableTwin(LIVE[0] as SavedStrategy, LIVE)?.id).toBe('defaults');
  });

  it('must match every other setting, the ignored ones aside', () => {
    const other = strategy('other', 0.4, { config_full: { ...BASE, broad_off_top_n: 12 } });
    expect(tradableTwin(LIVE[0] as SavedStrategy, [LIVE[0] as SavedStrategy, other])).toBeNull();
    const withTopN = strategy('topn', 0.4, { config_full: { ...BASE, top_n: 9 } });
    expect(
      tradableTwin(LIVE[0] as SavedStrategy, [LIVE[0] as SavedStrategy, withTopN], ['top_n'])?.id,
    ).toBe('topn');
  });
});

describe('the tradable twin on a universe that forces the filter on', () => {
  const PIT = { ...BASE, broad_universe: 'turnover_rank' };
  const circuitsOff = strategy('pit-circuits-off', 0.4, {
    config_full: { ...PIT, broad_respect_circuits: false },
    trust: 'not_tradable',
  });

  it('counts a stored filter-off as on, as the server does', () => {
    const stored = strategy('pit-stored-off', 0.35, {
      config_full: { ...PIT, broad_liquidity_filter: false },
    });
    expect(tradableTwin(circuitsOff, [circuitsOff, stored])?.id).toBe('pit-stored-off');
  });

  it("still needs the filter on when the universe is today's list", () => {
    const today = { ...BASE, broad_universe: 'total_market' };
    const offToday = strategy('today-off', 0.4, {
      config_full: { ...today, broad_respect_circuits: false },
      trust: 'not_tradable',
    });
    const filterOff = strategy('today-filter-off', 0.35, {
      config_full: { ...today, broad_liquidity_filter: false },
    });
    expect(tradableTwin(offToday, [offToday, filterOff])).toBeNull();
  });
});

describe('savedFindings', () => {
  it("finds screen 1's five on the live strategies, in order", () => {
    const findings = savedFindings(LIVE, name);
    expect(findings.map((f) => f.id)).toEqual([
      'not-tradable',
      'moved',
      'not-comparable',
      'in-sample',
      'folded',
    ]);
    expect(findings[0]?.detail).toContain('defaults: 41.3%');
    expect(findings[0]?.action).toEqual({
      kind: 'compare',
      ids: ['liq-off', 'defaults'],
      label: 'Compare the two ›',
    });
    expect(findings[1]?.detail).toContain('the cause is unknown');
    expect(findings[2]?.title).toBe('stock-core is not comparable with the rest');
    expect(findings[4]?.title).toBe('16 saved runs are 5 strategies');
  });

  it('puts a moved result to review first, a bug before a check, and keeps five', () => {
    const review = [
      strategy('check', 0.2, { change: change('check', true), unreviewed: 1 }),
      strategy('bug', 0.2, { change: change('not_reproducible', true), unreviewed: 1 }),
      ...LIVE,
    ];
    const findings = savedFindings(review, name);
    expect(findings).toHaveLength(MAX_FINDINGS);
    expect(findings[0]).toMatchObject({ id: 'review', tone: 'negative' });
    expect(findings[0]?.title).toBe('2 moved results need a look');
    expect(findings[0]?.action).toMatchObject({ kind: 'open', id: 'bug' });
  });

  it('says nothing when there is nothing to say', () => {
    expect(savedFindings([strategy('only', 0.3)], name)).toEqual([]);
  });

  it('leaves groups out and looks inside them', () => {
    const member = strategy('m', 0.3, { trust: 'validated', member_of: 'g' });
    const group = strategy('g', 0, { group: ['m'], members: [member], trust: null });
    const findings = savedFindings([group, strategy('best', 0.5)], name);
    expect(findings.map((f) => f.id)).toEqual(['in-sample']);
  });
});

describe('review fixes', () => {
  it('keeps the end date in the twin identity', () => {
    const other = strategy('other-end', 0.4, { config_full: { ...BASE, end: '2024-12-31' } });
    expect(tradableTwin(LIVE[0] as SavedStrategy, [LIVE[0] as SavedStrategy, other])).toBeNull();
    const sameEnd = strategy('same', 0.4, { config_full: { ...BASE, end: '' } });
    expect(tradableTwin(LIVE[0] as SavedStrategy, [LIVE[0] as SavedStrategy, sameEnd])?.id).toBe(
      'same',
    );
  });

  it('still finds a change to review after a later repeat hid it from the latest run', () => {
    const hidden = strategy('hidden', 0.2, { change: null, unreviewed: 1 });
    const [first] = savedFindings([hidden, strategy('b', 0.1)], name);
    expect(first).toMatchObject({ id: 'review', title: 'hidden: a moved result needs a look' });
  });

  it('names no usual start when no start is used by most strategies', () => {
    const three = [
      strategy('a', 0.3, { config_full: { start: '2012-01-01' } }),
      strategy('b', 0.2, { config_full: { start: '2017-01-01' } }),
      strategy('c', 0.1, { config_full: { start: '2019-01-01' } }),
    ];
    expect(savedFindings(three, name).map((f) => f.id)).not.toContain('not-comparable');
  });

  it('counts only in-sample results against the validated ones', () => {
    const list = [
      strategy('v', 0.3, { trust: 'validated' }),
      strategy('nt', 0.5, { trust: 'not_tradable', config_full: off }),
      strategy('old', 0.4, { trust: 'old_data' }),
    ];
    expect(savedFindings(list, name).map((f) => f.id)).not.toContain('in-sample');
  });
});
