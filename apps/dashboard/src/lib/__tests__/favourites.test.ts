import { describe, expect, it } from 'vitest';

import {
  type FavouriteSet,
  favouriteSelectors,
  isListStarred,
  isStrategyStarred,
  listSelector,
  setOf,
  toggleList,
  toggleStrategy,
} from '../favourites';

const set = (lists: FavouriteSet['lists'], strategies: string[] = []): FavouriteSet => ({
  lists,
  strategies,
});

describe('favourites', () => {
  it('stars and un-stars a list, always in canonical order', () => {
    expect(toggleList(set(['A', 'C']), 'B').lists).toEqual(['A', 'B', 'C']);
    expect(toggleList(set(['A', 'B', 'C']), 'B').lists).toEqual(['A', 'C']);
    expect(toggleList(set([]), 'base').lists).toEqual(['base']);
    expect(toggleList(set(['base', 'A']), 'REF').lists).toEqual(['A', 'REF', 'base']);
  });

  it('stars a strategy by appending and un-stars it by removing', () => {
    expect(toggleStrategy(set([], ['x']), 'y').strategies).toEqual(['x', 'y']);
    expect(toggleStrategy(set([], ['x', 'y']), 'x').strategies).toEqual(['y']);
  });

  it('never mutates the set it was given', () => {
    const before = set(['A'], ['x']);
    toggleList(before, 'B');
    toggleStrategy(before, 'y');
    expect(before).toEqual({ lists: ['A'], strategies: ['x'] });
  });

  it('answers whether something is starred', () => {
    const s = set(['A'], ['x']);
    expect(isListStarred(s, 'A')).toBe(true);
    expect(isListStarred(s, 'B')).toBe(false);
    expect(isStrategyStarred(s, 'x')).toBe(true);
    expect(isStrategyStarred(s, 'z')).toBe(false);
  });

  it('turns stars into correlation selectors, leaving out what cannot be correlated', () => {
    expect(listSelector('A')).toBe('list:A');
    expect(listSelector('base')).toBeNull();
    expect(favouriteSelectors(set(['A', 'base', 'C'], ['nifty_buy_range_breakout']))).toEqual([
      'list:A',
      'list:C',
      'nifty_buy_range_breakout',
    ]);
    expect(favouriteSelectors(set([]))).toEqual([]);
  });

  it('copies a server answer into a set', () => {
    const copy = setOf({ lists: ['A'], strategies: ['x'] });
    expect(copy).toEqual({ lists: ['A'], strategies: ['x'] });
  });
});
