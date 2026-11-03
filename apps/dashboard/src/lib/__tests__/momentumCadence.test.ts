import { describe, expect, it } from 'vitest';

import {
  cadenceRule,
  isRebalanceWeek,
  nextRebalanceFriday,
  phaseRule,
  weeksSinceEpoch,
} from '../momentumCadence';
import { describeConfig } from '../momentumConfig';

const every4 = (offset: number) => ({
  rebalance: 'weekly',
  rebalance_every: 4,
  rebalance_offset: offset,
});

describe('weeksSinceEpoch', () => {
  it('counts whole weeks from Friday 1 Jan 2016', () => {
    expect(weeksSinceEpoch('2016-01-01')).toBe(0);
    expect(weeksSinceEpoch('2016-01-08')).toBe(1);
    expect(weeksSinceEpoch('2026-10-23')).toBe(564);
  });
});

describe('isRebalanceWeek / nextRebalanceFriday', () => {
  it('follows the engine: weeks since the epoch mod the interval equals the offset', () => {
    // 2026-10-23 is week 564, and 564 mod 4 = 0.
    expect(isRebalanceWeek('2026-10-23', every4(0))).toBe(true);
    expect(isRebalanceWeek('2026-10-23', every4(2))).toBe(false);
    expect(nextRebalanceFriday('2026-10-23', every4(0))).toBe('2026-11-20');
    expect(nextRebalanceFriday('2026-10-23', every4(2))).toBe('2026-11-06');
  });

  it('agrees with a frozen server explain line (every 4 weeks, phase 1, next 04 Jul 2025)', () => {
    // The golden scenario broad_one_category_three_picks_four_weekly's last week is an off week
    // whose `explain` names 04 Jul 2025 as the next rebalance.
    expect(isRebalanceWeek('2025-06-27', every4(0))).toBe(false);
    expect(nextRebalanceFriday('2025-06-27', every4(0))).toBe('2025-07-04');
    expect(isRebalanceWeek('2025-07-04', every4(0))).toBe(true);
  });

  it('monthly trades on the last Friday of each month', () => {
    const monthly = { rebalance: 'monthly' };
    expect(isRebalanceWeek('2026-10-30', monthly)).toBe(true);
    expect(isRebalanceWeek('2026-10-23', monthly)).toBe(false);
    expect(nextRebalanceFriday('2026-10-23', monthly)).toBe('2026-10-30');
    expect(nextRebalanceFriday('2026-10-30', monthly)).toBe('2026-11-27');
  });

  it('has no next Friday when every week trades or for an All (split) run', () => {
    expect(isRebalanceWeek('2026-10-23', { rebalance: 'weekly', rebalance_every: 1 })).toBe(true);
    expect(nextRebalanceFriday('2026-10-23', { rebalance: 'weekly', rebalance_every: 1 })).toBe(
      null,
    );
    expect(nextRebalanceFriday('2026-10-23', { ...every4(0), split_fridays: true })).toBe(null);
    expect(nextRebalanceFriday('not a day', every4(0))).toBe(null);
  });
});

describe('cadenceRule', () => {
  it('names the rule behind "phase N"', () => {
    expect(cadenceRule(every4(2))).toBe(phaseRule(4, 2));
    expect(phaseRule(4, 2)).toBe(
      'Phase 3 of 4 trades on the Fridays whose number of weeks since Friday 1 Jan 2016, divided by 4, leaves 2.',
    );
    expect(cadenceRule({ rebalance: 'monthly' })).toBe('Trades on the last Friday of each month.');
  });

  it('says nothing for a weekly cadence or an All (split) run', () => {
    expect(cadenceRule({ rebalance: 'weekly', rebalance_every: 1 })).toBe(null);
    expect(cadenceRule({ ...every4(0), split_fridays: true })).toBe(null);
  });

  it('is the cadence chip’s tooltip', () => {
    const chip = describeConfig(every4(2), 'etf').chips.find((c) => c.id === 'cadence');
    expect(chip?.label).toBe('Every 4 weeks (phase 3)');
    expect(chip?.title).toBe(phaseRule(4, 2));
    const weekly = describeConfig({ rebalance: 'weekly' }, 'etf').chips.find(
      (c) => c.id === 'cadence',
    );
    expect(weekly && 'title' in weekly).toBe(false);
  });
});
