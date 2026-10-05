import { describe, expect, it } from 'vitest';

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

  it('starts split, with everything collapsed and no details tab open', () => {
    expect(DEFAULT_MOMENTUM_VIEW).toEqual({
      resultsExpanded: false,
      weekChangesOpen: false,
      drawdownOpen: false,
      advancedTooltip: false,
      detailsTab: null,
    });
  });

  it.each([null, 42, 'x', [], [{ resultsExpanded: true }]])(
    'gives the defaults for a non-object value (%j)',
    (value) => {
      expect(normalizeMomentumView(value)).toEqual(DEFAULT_MOMENTUM_VIEW);
    },
  );

  it('keeps a complete valid value', () => {
    const stored = {
      resultsExpanded: true,
      weekChangesOpen: true,
      drawdownOpen: true,
      advancedTooltip: true,
      detailsTab: 'trades',
    };
    expect(parseStoredMomentumView(JSON.stringify(stored))).toEqual(stored);
  });

  it('falls back field by field', () => {
    expect(
      normalizeMomentumView({
        resultsExpanded: 'yes',
        weekChangesOpen: true,
        drawdownOpen: 1,
        advancedTooltip: 'on',
        detailsTab: 'removed-tab',
      }),
    ).toEqual({ ...DEFAULT_MOMENTUM_VIEW, weekChangesOpen: true });
    // A value stored before the advanced tooltip existed: it stays off.
    expect(normalizeMomentumView({ drawdownOpen: true })).toEqual({
      ...DEFAULT_MOMENTUM_VIEW,
      drawdownOpen: true,
    });
  });

  it('the store updates one preference at a time', () => {
    useMomentumViewStore.setState(DEFAULT_MOMENTUM_VIEW);
    useMomentumViewStore.getState().setDetailsTab('risk');
    useMomentumViewStore.getState().setResultsExpanded(true);
    useMomentumViewStore.getState().setAdvancedTooltip(true);
    const state = useMomentumViewStore.getState();
    expect(state.detailsTab).toBe('risk');
    expect(state.resultsExpanded).toBe(true);
    expect(state.advancedTooltip).toBe(true);
    expect(state.drawdownOpen).toBe(false);
    useMomentumViewStore.setState(DEFAULT_MOMENTUM_VIEW);
  });
});
