import { describe, expect, it } from 'vitest';

import type { RotationListStats, RotationSummary } from '../../types/rotation';
import { baseBook, listBook, stopChanged, stopSummary, vsHeader } from '../rotationBooks';
import type { StopEffect } from '../rotationPortfolioView';

function stats(over: Partial<RotationListStats> = {}): RotationListStats {
  return {
    total: 27250,
    mean_day: 2725,
    per_lot_day: 908,
    lots_per_day: 3,
    max_drawdown: -8382,
    max_drawdown_per_lot: -2794,
    beats_random_pct: 98,
    random: { p10: 0, p50: 6000, p90: 0, max: 0 },
    mean_daily_random_percentile: 0.5,
    random_path: { p10: [], p50: [], p90: [] },
    vs_base: { mean: 902, lower: -158, upper: 1962, drawdown_no_worse: true, beats_base: false },
    vs_ref: null,
    ...over,
  };
}

function summary(over: Partial<RotationSummary> = {}): RotationSummary {
  return {
    settings: {
      lots_per_strategy: 1,
      random_runs: 1000,
      random_seed: 1,
      bootstrap_resamples: 2000,
      bootstrap_block_days: 5,
      bootstrap_seed: 1,
      interval: 0.9,
      basis: 'gross',
    },
    n_days: 10,
    first_day: '2026-10-12',
    last_day: '2026-10-27',
    pending_days: [],
    pending_reasons: {},
    late_entries: [],
    short: false,
    lists: { C: stats() },
    base: {
      definition: '',
      per_lot_day: 6,
      cumulative_per_lot: 60,
      max_drawdown_per_lot: -4424,
      lots_per_day: 3,
      total: 179,
      max_drawdown: -13273,
    },
    days: [
      { day: '2026-10-26', base: 0, base_total: 900, C_total: 4836 },
      { day: '2026-10-27', base: 0, base_total: 10501, C_total: -8382 },
    ],
    ...over,
  };
}

describe('listBook', () => {
  it('takes the read-out figures and the latest scored day', () => {
    const r = listBook('C', summary(), summary(), 'base');
    expect(r.latest).toEqual({ day: '2026-10-27', total: -8382 });
    expect(r.total).toBe(27250);
    expect(r.perLotDay).toBe(908);
    expect(r.maxDrawdownPerLot).toBe(-2794);
    expect(r.vsBenchmark).toBe(902);
    expect(r.beatsRandom).toBe(98);
    expect(r.scoredDays).toBe(10);
  });

  it('measures the gap against the random median when that is picked', () => {
    // random median per lot-day = p50 / (lots a day x days) = 6000 / 30 = 200
    expect(listBook('C', summary(), summary(), 'random').vsBenchmark).toBe(708);
  });

  it('keeps beats-random on the registered read-out, not the stopped one', () => {
    const stopped = summary({ lists: { C: stats({ beats_random_pct: 40 }) } });
    expect(listBook('C', stopped, summary(), 'base').beatsRandom).toBe(98);
  });

  it('is all dashes before a scored day, never zeros', () => {
    const r = listBook('T1', summary({ n_days: 0 }), null, 'base');
    expect(r.total).toBeNull();
    expect(r.latest).toBeNull();
    expect(r.vsBenchmark).toBeNull();
    expect(listBook('T1', null, null, 'base').perLotDay).toBeNull();
  });
});

describe('baseBook', () => {
  it('reads the base over the same sessions and has no gap to itself', () => {
    const r = baseBook(summary());
    expect(r.latest).toEqual({ day: '2026-10-27', total: 10501 });
    expect(r.total).toBe(179);
    expect(r.maxDrawdown).toBe(-13273);
    expect(r.vsBenchmark).toBeNull();
    expect(r.beatsRandom).toBeNull();
  });

  it('is empty without a base or a scored day', () => {
    expect(baseBook(summary({ base: null })).total).toBeNull();
    expect(baseBook(summary({ n_days: 0 })).total).toBeNull();
  });
});

const effect = (over: Partial<StopEffect> = {}): StopEffect => ({
  latest: null,
  days: 10,
  totalWith: 27250,
  totalWithout: 27250,
  ddWith: -8382,
  ddWithout: -8382,
  firedDays: 1,
  firedEffect: 0,
  skipped: 0,
  ...over,
});

describe('the stop cell', () => {
  it('says nothing changed when the totals and drawdowns agree', () => {
    expect(stopChanged(effect())).toBe(false);
    expect(stopChanged(null)).toBe(false);
    expect(stopChanged(effect({ totalWith: 28000 }))).toBe(true);
    expect(stopChanged(effect({ ddWith: -6000 }))).toBe(true);
  });

  it('summarises fired days and the change', () => {
    expect(stopSummary(effect({ totalWith: 28000 }))).toEqual({
      fired: 1,
      days: 10,
      change: 750,
      skipped: 0,
    });
    expect(stopSummary(null)).toBeNull();
  });

  it('names the benchmark in the gap header', () => {
    expect(vsHeader('base')).toBe('vs base');
    expect(vsHeader('random')).toBe('vs random median');
  });
});
