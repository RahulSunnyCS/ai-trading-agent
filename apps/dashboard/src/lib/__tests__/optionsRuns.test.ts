import { describe, expect, it } from 'vitest';

import type { RunResult, RunSummary } from '../../types/backtest';
import type { Leg, SavedResult, SavedStrategy } from '../../types/legwise';
import {
  type LegwiseRunRow,
  NET_UNIT_LABEL,
  canCompare,
  compareRuns,
  countByKind,
  coverageRange,
  describeLeg,
  filterRuns,
  headlineOfResult,
  headlineOfSummary,
  lastResultOf,
  legsSummary,
  legwiseRuns,
  legwiseStatsOf,
  mergeRuns,
  runBlockedReason,
  runMetrics,
  sessionEquity,
  yamlRuns,
} from '../optionsRuns';

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: 'abc123',
    strategy_id: 'B_pyramid',
    strategy_version: 1,
    strategy_hash: 'deadbeef',
    date_from: '2026-06-08',
    date_to: '2026-09-04',
    created_at: '2026-09-20 18:05:00+05:30',
    net_inr: 12000,
    win_days: 30,
    worst_day: -4000,
    sum_peak_loss: -50000,
    lot_days: 120,
    inr_per_lot_day: 100,
    n_sessions: 50,
    ...over,
  };
}

function day(over: Partial<LegwiseRunRow> = {}): LegwiseRunRow {
  return {
    strategy_id: 'straddle',
    strategy_sha: 'sha1',
    current: true,
    day: '2026-09-23',
    gross: 0,
    costs: 0,
    net: 0,
    worst_mtm: 0,
    best_mtm: 0,
    stopped_by: null,
    notes: [],
    trades: [],
    ...over,
  };
}

function leg(over: Partial<Leg> = {}): Leg {
  return {
    id: 'ce',
    lots: 1,
    position: 'sell',
    option_type: 'CE',
    expiry: 'weekly',
    strike: { strike_type: 'ATM' },
    ...over,
  };
}

function strategy(id: string, sha: string, lots: number): SavedStrategy {
  return {
    name: id,
    sha,
    strategy: {
      id,
      underlying: 'NIFTY',
      entry_time: '09:20',
      exit_time: '15:15',
      square_off: 'partial',
      legs: [leg({ lots }), leg({ id: 'pe', option_type: 'PE', lots })],
      overall: {},
      execution: { slippage_pct: 0, cost_per_order_inr: 0 },
    },
  };
}

describe('yamlRuns', () => {
  it('reports the registry net as a total', () => {
    const [run] = yamlRuns([summary()]);
    expect(run).toMatchObject({
      key: 'yaml:abc123',
      kind: 'yaml',
      strategy: 'B_pyramid',
      net: 12000,
      netUnit: 'total',
      days: 50,
      winDays: 30,
      from: '2026-06-08',
      to: '2026-09-04',
      current: null,
    });
    expect(run?.sortTime).toBe(Date.parse('2026-09-20T18:05:00+05:30'));
    expect(run?.recordedAt).toBe('2026-09-20T12:35:00.000Z');
  });

  it('reads the timestamp forms the catalog produces', () => {
    const at = (created_at: string) => yamlRuns([summary({ created_at })])[0]?.recordedAt;
    expect(at('2026-09-20 12:35:00+00')).toBe('2026-09-20T12:35:00.000Z');
    expect(at('2026-09-20 18:05:00.123456+05:30')).toBe('2026-09-20T12:35:00.123Z');
    expect(at('2026-09-20T12:35:00Z')).toBe('2026-09-20T12:35:00.000Z');
    expect(at('nope')).toBeNull();
  });

  it('orders a run with an unreadable timestamp by its last day', () => {
    const [run] = yamlRuns([summary({ created_at: 'nope' })]);
    expect(run?.sortTime).toBe(Date.parse('2026-09-04T10:00:00Z'));
  });
});

describe('legwiseRuns', () => {
  const rows = [
    day({ day: '2026-09-24', net: 400 }),
    day({ day: '2026-09-23', net: -100 }),
    day({ day: '2026-09-23', net: 50, strategy_sha: 'old', current: false }),
    day({ day: '2026-09-23', net: 900, strategy_id: 'other' }),
  ];

  it('makes one daily run per strategy version, per lot when the saved version is known', () => {
    const runs = legwiseRuns(rows, [strategy('straddle', 'sha1', 2)]);
    expect(runs.map((r) => r.key)).toEqual([
      'daily:straddle@sha1',
      'daily:straddle@old',
      'daily:other@sha1',
    ]);
    expect(runs[0]).toMatchObject({
      kind: 'daily',
      from: '2026-09-23',
      to: '2026-09-24',
      days: 2,
      winDays: 1,
      net: 150,
      netUnit: 'per_lot',
      current: true,
      recordedAt: null,
    });
  });

  it('keeps a total, labelled as one, when the lot divisor is not known', () => {
    const runs = legwiseRuns(rows, [strategy('straddle', 'sha1', 2)]);
    // An older version of a saved strategy: the file's lots may not be that version's.
    expect(runs[1]).toMatchObject({ net: 50, netUnit: 'total', current: false });
    // A strategy with no saved file.
    expect(runs[2]).toMatchObject({ net: 900, netUnit: 'total' });
    expect(legwiseRuns(rows)[0]).toMatchObject({ net: 300, netUnit: 'total' });
  });

  it('reads kind, run id and timestamp when a row carries them', () => {
    const runs = legwiseRuns([
      day({ kind: 'adhoc', run_id: 'r1', created_at: '2026-10-01T09:00:00Z', net: 10 }),
      day({ kind: 'adhoc', run_id: 'r1', day: '2026-09-24', net: 20 }),
      day({ kind: 'adhoc', run_id: 'r2', net: 5 }),
      day({ kind: 'daily', net: 1 }),
    ]);
    expect(runs.map((r) => [r.key, r.kind, r.days])).toEqual([
      ['builder:r1', 'builder', 2],
      ['builder:r2', 'builder', 1],
      ['daily:straddle@sha1', 'daily', 1],
    ]);
    expect(runs[0]?.recordedAt).toBe('2026-10-01T09:00:00.000Z');
    expect(runs[0]?.sortTime).toBe(Date.parse('2026-10-01T09:00:00Z'));
  });

  it('returns nothing for no rows', () => {
    expect(legwiseRuns([])).toEqual([]);
  });
});

describe('mergeRuns', () => {
  it('lists both engines newest first', () => {
    const merged = mergeRuns(
      [
        summary({ run_id: 'old', created_at: '2026-09-01T10:00:00Z' }),
        summary({ run_id: 'new', created_at: '2026-09-30T10:00:00Z' }),
      ],
      [day({ day: '2026-09-23', net: 100 }), day({ day: '2026-09-24', net: 100 })],
    );
    expect(merged.map((r) => r.key)).toEqual(['yaml:new', 'daily:straddle@sha1', 'yaml:old']);
  });

  it('breaks a tie by key so the order is stable', () => {
    const merged = mergeRuns(
      [],
      [day({ strategy_id: 'b' }), day({ strategy_id: 'a' }), day({ strategy_id: 'c' })],
    );
    expect(merged.map((r) => r.strategy)).toEqual(['a', 'b', 'c']);
  });

  it('never mixes units: YAML is total, a known leg-wise version is per lot', () => {
    const merged = mergeRuns([summary()], [day({ net: 300 })], [strategy('straddle', 'sha1', 3)]);
    expect(merged.map((r) => [r.kind, r.netUnit, r.net])).toEqual([
      ['daily', 'per_lot', 100],
      ['yaml', 'total', 12000],
    ]);
    expect(NET_UNIT_LABEL.per_lot).not.toBe(NET_UNIT_LABEL.total);
  });
});

describe('filterRuns', () => {
  const runs = mergeRuns(
    [summary()],
    [day(), day({ strategy_id: 'Iron_Condor' }), day({ kind: 'adhoc', run_id: 'r1' })],
  );

  it('filters by kind', () => {
    expect(filterRuns(runs, { kind: 'all', text: '' })).toHaveLength(4);
    expect(filterRuns(runs, { kind: 'yaml', text: '' }).map((r) => r.kind)).toEqual(['yaml']);
    expect(filterRuns(runs, { kind: 'builder', text: '' })).toHaveLength(1);
    expect(filterRuns(runs, { kind: 'daily', text: '' })).toHaveLength(2);
  });

  it('filters by strategy text, ignoring case and outer spaces', () => {
    expect(filterRuns(runs, { kind: 'all', text: ' iron ' }).map((r) => r.strategy)).toEqual([
      'Iron_Condor',
    ]);
    expect(filterRuns(runs, { kind: 'yaml', text: 'iron' })).toEqual([]);
  });

  it('counts by kind', () => {
    expect(countByKind(runs)).toEqual({ all: 4, yaml: 1, builder: 1, daily: 2 });
  });
});

describe('comparing runs', () => {
  const a = yamlRuns([summary({ run_id: 'a', net_inr: 1000, win_days: 10, n_sessions: 20 })])[0];
  const b = yamlRuns([summary({ run_id: 'b', net_inr: 1500, win_days: 5, n_sessions: 20 })])[0];
  const daily = legwiseRuns(
    [day({ net: 200 }), day({ day: '2026-09-24', net: -100 })],
    [strategy('straddle', 'sha1', 1)],
  )[0];
  if (!a || !b || !daily) throw new Error('fixtures');

  it('only compares two different runs of one kind', () => {
    expect(canCompare(a, b)).toBe(true);
    expect(canCompare(a, a)).toBe(false);
    expect(canCompare(a, daily)).toBe(false);
    expect(compareRuns(a, daily)).toBeNull();
  });

  it('lines YAML metrics up and marks the better side', () => {
    const rows = compareRuns(a, b);
    expect(rows?.map((r) => r.label)).toEqual(runMetrics(a).map((m) => m.label));
    const net = rows?.find((r) => r.label === 'Net (total)');
    expect(net).toMatchObject({ a: 1000, b: 1500, delta: 500, better: 'b', format: 'inr' });
    const win = rows?.find((r) => r.label === 'Win rate');
    expect(win).toMatchObject({ a: 0.5, b: 0.25, better: 'a', format: 'pct' });
    // A count has no better direction; an equal value has no winner.
    expect(rows?.find((r) => r.label === 'Sessions')).toMatchObject({ delta: 0, better: null });
    expect(rows?.find((r) => r.label === 'Lot-days')?.better).toBeNull();
  });

  it('treats a less negative worst day as the better one', () => {
    const worse = yamlRuns([summary({ run_id: 'w', worst_day: -9000 })])[0];
    if (!worse) throw new Error('fixture');
    const row = compareRuns(a, worse)?.find((r) => r.label === 'Worst day (total)');
    expect(row).toMatchObject({ a: -4000, b: -9000, better: 'a' });
  });

  it('labels leg-wise metrics with the run unit and drops money rows across units', () => {
    expect(runMetrics(daily).map((m) => m.label)).toContain('Net (/ lot)');
    const totalRun = legwiseRuns([day({ strategy_id: 'x', net: 50 })])[0];
    if (!totalRun) throw new Error('fixture');
    expect(runMetrics(totalRun).map((m) => m.label)).toContain('Net (total)');
    expect(compareRuns(daily, totalRun)?.map((r) => r.label)).toEqual([
      'Days',
      'Win rate',
      'Profit factor',
    ]);
  });

  it('gives a null delta when a metric is missing on one side', () => {
    const noLosses = legwiseRuns(
      [day({ strategy_id: 'w', net: 100 })],
      [strategy('w', 'sha1', 1)],
    )[0];
    if (!noLosses) throw new Error('fixture');
    const pf = compareRuns(daily, noLosses)?.find((r) => r.label === 'Profit factor');
    expect(pf).toMatchObject({ a: 2, b: null, delta: null, better: null });
  });

  it('computes leg-wise statistics in the run unit', () => {
    const twoLots = legwiseRuns([day({ net: 200 })], [strategy('straddle', 'sha1', 2)])[0];
    if (!twoLots) throw new Error('fixture');
    expect(legwiseStatsOf(twoLots)?.total).toBe(100);
    expect(legwiseStatsOf(a)).toBeNull();
  });
});

describe('YAML result helpers', () => {
  const result: RunResult = {
    run_id: 'r',
    net_inr: 300,
    gross_inr: 400,
    win_days: 2,
    worst_day: -100,
    sum_peak_loss: -500,
    worst_intraday_mtm: -250,
    lot_days: 6,
    inr_per_lot_day: 50,
    dte_buckets: {},
    sessions: [
      {
        date: '2026-06-10',
        dte: 1,
        net: 250.4,
        gross: 0,
        cost: 0,
        lot_days: 2,
        peak_loss: 0,
        total_lots: 2,
      },
      {
        date: '2026-06-08',
        dte: 3,
        net: 150.4,
        gross: 0,
        cost: 0,
        lot_days: 2,
        peak_loss: 0,
        total_lots: 2,
      },
      {
        date: '2026-06-09',
        dte: 2,
        net: -100,
        gross: 0,
        cost: 0,
        lot_days: 2,
        peak_loss: 0,
        total_lots: 2,
      },
    ],
    bootstrap: null,
    margin: null,
    regime_buckets: null,
  };

  it('builds the same headline from a result and from a registry row', () => {
    expect(headlineOfResult(result)).toEqual({
      runId: 'r',
      net: 300,
      gross: 400,
      winDays: 2,
      sessions: 3,
      worstDay: -100,
      sumPeakLoss: -500,
      lotDays: 6,
      inrPerLotDay: 50,
    });
    expect(headlineOfSummary(summary())).toMatchObject({ gross: null, sessions: 50, net: 12000 });
  });

  it('accumulates net by session in date order', () => {
    expect(sessionEquity(result.sessions)).toEqual([
      { time: '2026-06-08', value: 150 },
      { time: '2026-06-09', value: 50 },
      { time: '2026-06-10', value: 301 },
    ]);
    expect(sessionEquity([])).toEqual([]);
  });

  it('spans every cached timeframe', () => {
    expect(
      coverageRange({
        '15m': { start: '2026-06-08', end: '2026-09-04' },
        '5m': { start: '2026-06-01', end: '2026-08-30' },
      }),
    ).toEqual({ from: '2026-06-01', to: '2026-09-04' });
    expect(coverageRange({})).toBeNull();
    expect(coverageRange(null)).toBeNull();
  });

  it('says why a run is blocked, most basic reason first', () => {
    const ok = {
      yaml: 'id: x',
      validating: false,
      valid: true,
      errorCount: 0,
      validationError: null,
      from: '2026-06-08',
      to: '2026-09-04',
    };
    expect(runBlockedReason(ok)).toBeNull();
    expect(runBlockedReason({ ...ok, yaml: ' ' })).toMatch(/preset/);
    expect(runBlockedReason({ ...ok, validating: true })).toMatch(/Checking/);
    expect(runBlockedReason({ ...ok, valid: null })).toMatch(/Checking/);
    expect(runBlockedReason({ ...ok, valid: null, validationError: 'down' })).toMatch(
      /could not be validated/,
    );
    expect(runBlockedReason({ ...ok, valid: false, errorCount: 1 })).toBe(
      'Fix the validation error first.',
    );
    expect(runBlockedReason({ ...ok, valid: false, errorCount: 3 })).toBe(
      'Fix the 3 validation errors first.',
    );
    expect(runBlockedReason({ ...ok, from: '', to: '' })).toBe('Choose a From and a To date.');
    expect(runBlockedReason({ ...ok, from: '' })).toBe('Choose a From date.');
    expect(runBlockedReason({ ...ok, to: '' })).toBe('Choose a To date.');
    expect(runBlockedReason({ ...ok, from: '2026-09-05' })).toBe('From is after To.');
  });
});

describe('saved strategies', () => {
  it('describes a leg', () => {
    expect(describeLeg(leg())).toBe('Sell CE ATM');
    expect(
      describeLeg(
        leg({ position: 'buy', option_type: 'PE', lots: 2, strike: { closest_premium: 50 } }),
      ),
    ).toBe('2 lots Buy PE ₹50 premium');
    expect(describeLeg(leg({ strike: { closest_premium: 62.5 } }))).toBe('Sell CE ₹62.5 premium');
    expect(describeLeg(leg({ strike: {} }))).toBe('Sell CE');
  });

  it('summarises legs', () => {
    expect(legsSummary(strategy('s', 'sha', 1).strategy.legs)).toEqual({
      count: 2,
      text: 'Sell CE ATM · Sell PE ATM',
    });
    expect(legsSummary([])).toEqual({ count: 0, text: '' });
  });

  it('finds the saved version last result, per lot', () => {
    const results: SavedResult[] = [
      day({ day: '2026-09-23', net: 400 }),
      day({ day: '2026-09-25', net: -100 }),
      day({ day: '2026-09-24', net: 9999, strategy_sha: 'old', current: false }),
      day({ day: '2026-09-24', net: 9999, strategy_id: 'other' }),
    ];
    expect(lastResultOf(strategy('straddle', 'sha1', 2), results)).toEqual({
      netPerLot: 150,
      days: 2,
      upDays: 1,
      lastDay: '2026-09-25',
    });
    expect(lastResultOf(strategy('straddle', 'sha2', 2), results)).toBeNull();
  });
});
