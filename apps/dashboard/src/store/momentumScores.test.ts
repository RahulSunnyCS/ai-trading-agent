// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MOMENTUM_SCORES_STORAGE_KEY,
  hydrateMomentumScoresFromStorage,
  parseHiddenColumns,
  parseMinStocks,
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

describe('parseMinStocks', () => {
  it('reads one of the offered choices', () => {
    expect(parseMinStocks('{"minStocks":3}')).toBe(3);
    expect(parseMinStocks('{"minStocks":10}')).toBe(10);
  });
  it('falls back to 5 for anything else', () => {
    for (const stored of [null, '', '{bad', '{"minStocks":4}', '{"minStocks":"3"}', '[3]', '{}']) {
      expect(parseMinStocks(stored)).toBe(5);
    }
  });
});

describe('the scores store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMomentumScoresStore.setState({ hidden: new Set(), minStocks: 5 });
  });
  afterEach(() => window.localStorage.clear());

  it('hides and shows a column, and remembers it', () => {
    useMomentumScoresStore.getState().setColumnShown('spark', false);
    expect(useMomentumScoresStore.getState().hidden.has('spark')).toBe(true);
    expect(window.localStorage.getItem(MOMENTUM_SCORES_STORAGE_KEY)).toBe(
      '{"hidden":["spark"],"minStocks":5}',
    );
    useMomentumScoresStore.getState().setColumnShown('spark', true);
    expect(useMomentumScoresStore.getState().hidden.size).toBe(0);
  });

  it('applies the stored choice after mount', () => {
    window.localStorage.setItem(MOMENTUM_SCORES_STORAGE_KEY, '{"hidden":["trend"]}');
    hydrateMomentumScoresFromStorage();
    expect(useMomentumScoresStore.getState().hidden).toEqual(new Set(['trend']));
  });

  it('remembers the fewest stocks for a map dot, next to the hidden columns', () => {
    useMomentumScoresStore.getState().setColumnShown('price', false);
    useMomentumScoresStore.getState().setMinStocks(10);
    expect(window.localStorage.getItem(MOMENTUM_SCORES_STORAGE_KEY)).toBe(
      '{"hidden":["price"],"minStocks":10}',
    );
    useMomentumScoresStore.setState({ hidden: new Set(), minStocks: 5 });
    hydrateMomentumScoresFromStorage();
    expect(useMomentumScoresStore.getState().minStocks).toBe(10);
    expect(useMomentumScoresStore.getState().hidden).toEqual(new Set(['price']));
  });
});
