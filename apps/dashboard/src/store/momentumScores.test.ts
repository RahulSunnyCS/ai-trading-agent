// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MOMENTUM_SCORES_STORAGE_KEY,
  hydrateMomentumScoresFromStorage,
  parseHiddenColumns,
  useMomentumScoresStore,
} from './momentumScores';

describe('parseHiddenColumns', () => {
  it('reads known columns and drops anything else', () => {
    expect(parseHiddenColumns(JSON.stringify({ hidden: ['sector', 'price', 'bogus', 7] }))).toEqual(
      new Set(['sector', 'price']),
    );
  });
  it('falls back to showing everything for nothing, bad JSON or a wrong shape', () => {
    for (const stored of [null, '', '{not json', '[]', '{"hidden":"sector"}', 'null']) {
      expect(parseHiddenColumns(stored).size).toBe(0);
    }
  });
});

describe('the scores store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMomentumScoresStore.setState({ hidden: new Set() });
  });
  afterEach(() => window.localStorage.clear());

  it('hides and shows a column, and remembers it', () => {
    useMomentumScoresStore.getState().setColumnShown('spark', false);
    expect(useMomentumScoresStore.getState().hidden.has('spark')).toBe(true);
    expect(window.localStorage.getItem(MOMENTUM_SCORES_STORAGE_KEY)).toBe('{"hidden":["spark"]}');
    useMomentumScoresStore.getState().setColumnShown('spark', true);
    expect(useMomentumScoresStore.getState().hidden.size).toBe(0);
  });

  it('applies the stored choice after mount', () => {
    window.localStorage.setItem(MOMENTUM_SCORES_STORAGE_KEY, '{"hidden":["trend"]}');
    hydrateMomentumScoresFromStorage();
    expect(useMomentumScoresStore.getState().hidden).toEqual(new Set(['trend']));
  });
});
