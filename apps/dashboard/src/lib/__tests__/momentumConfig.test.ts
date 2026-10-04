import { describe, expect, it } from 'vitest';

import { describeConfig } from '../momentumConfig';

const BASE = {
  start: '2017-01-06',
  end: '2026-09-25',
  benchmark: 'Nifty 500',
  top_n: 5,
  exit_rank: 10,
};

describe('describeConfig', () => {
  it('describes an ETF config from top_n / exit_rank', () => {
    expect(describeConfig({ ...BASE, rebalance: 'weekly', rebalance_every: 1 }, 'etf')).toEqual({
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
