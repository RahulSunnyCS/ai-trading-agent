import { describe, expect, it } from 'vitest';

import type { RotationListStats, RotationSummary } from '../../types/rotation';
import { basketLine } from '../strategiesBasketLine';

function summary(over: Partial<RotationSummary> = {}): RotationSummary {
  return {
    settings: {} as RotationSummary['settings'],
    n_days: 10,
    first_day: '2026-10-12',
    last_day: '2026-10-27',
    pending_days: [],
    pending_reasons: {},
    late_entries: [],
    short: false,
    lists: {
      C: { total: 27250, max_drawdown: -8381.75 } as unknown as RotationListStats,
    },
    base: null,
    ...over,
  };
}

describe('basketLine', () => {
  it('reads the forward days, first day, total and drawdown as the Today cards do', () => {
    expect(basketLine(summary(), 'C', null)).toEqual({
      state: 'ready',
      forwardDays: 10,
      firstDay: '2026-10-12',
      total: 27250,
      maxDrawdown: -8381.75,
    });
  });

  it('says it is loading rather than showing a bare dash', () => {
    expect(basketLine(null, 'C', null)).toEqual({ state: 'loading' });
  });

  it('carries the reason when the read-out could not be read', () => {
    expect(basketLine(null, 'C', 'HTTP 500')).toEqual({ state: 'error', reason: 'HTTP 500' });
  });

  it('keeps the last figures read when a refresh fails', () => {
    expect(basketLine(summary(), 'C', 'HTTP 500').state).toBe('ready');
  });

  it('never turns no scored day into a zero', () => {
    expect(basketLine(summary({ n_days: 0, lists: {} }), 'C', null)).toEqual({ state: 'none' });
    // Scored days but nothing for this list: a dash with its reason, not a zero.
    expect(basketLine(summary({ lists: {} }), 'C', null)).toEqual({ state: 'missing' });
  });
});
