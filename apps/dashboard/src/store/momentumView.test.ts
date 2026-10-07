import { describe, expect, it } from 'vitest';

import { DEFAULT_BENCHMARK } from '../lib/momentumBenchmark';
import {
  DEFAULT_MOMENTUM_VIEW,
  normalizeMomentumView,
  parseStoredMomentumView,
  useMomentumViewStore,
} from './momentumView';

describe('momentum view preferences', () => {
  it('gives the defaults when nothing is stored or the JSON is bad', () => {
    expect(parseStoredMomentumView(null)).toEqual(DEFAULT_MOMENTUM_VIEW);
    expect(parseStoredMomentumView('')).toEqual(DEFAULT_MOMENTUM_VIEW);
    expect(parseStoredMomentumView('{not json')).toEqual(DEFAULT_MOMENTUM_VIEW);
  });

  it('starts against Nifty 200 Momentum 30, with everything collapsed', () => {
    expect(DEFAULT_MOMENTUM_VIEW).toEqual({
      benchmark: DEFAULT_BENCHMARK,
      weekChangesOpen: false,
      drawdownOpen: false,
      metricsOpen: false,
    });
  });

  it.each([null, 42, 'x', [], [{ drawdownOpen: true }]])(
    'gives the defaults for a non-object value (%j)',
    (value) => {
      expect(normalizeMomentumView(value)).toEqual(DEFAULT_MOMENTUM_VIEW);
    },
  );

  it('keeps a complete valid value', () => {
    const stored = {
      benchmark: 'Nifty 50 TRI',
      weekChangesOpen: true,
      drawdownOpen: true,
      metricsOpen: true,
    };
    expect(parseStoredMomentumView(JSON.stringify(stored))).toEqual(stored);
  });

  it('falls back field by field and ignores the earlier layout keys', () => {
    expect(
      normalizeMomentumView({
        benchmark: '',
        weekChangesOpen: true,
        drawdownOpen: 1,
        resultsExpanded: true,
        advancedTooltip: true,
        detailsTab: 'trades',
      }),
    ).toEqual({ ...DEFAULT_MOMENTUM_VIEW, weekChangesOpen: true });
  });

  it('the store updates one preference at a time', () => {
    useMomentumViewStore.setState(DEFAULT_MOMENTUM_VIEW);
    useMomentumViewStore.getState().setBenchmark('Nifty Midcap 150 TRI');
    useMomentumViewStore.getState().setMetricsOpen(true);
    const state = useMomentumViewStore.getState();
    expect(state.benchmark).toBe('Nifty Midcap 150 TRI');
    expect(state.metricsOpen).toBe(true);
    expect(state.drawdownOpen).toBe(false);
    useMomentumViewStore.setState(DEFAULT_MOMENTUM_VIEW);
  });
});
