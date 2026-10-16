import { describe, expect, it } from 'vitest';

import {
  type FavouriteSet,
  correlateHref,
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
    expect(listSelector('C')).toBe('list:C');
    expect(listSelector('base')).toBeNull();
    expect(favouriteSelectors(set(['A', 'base', 'C'], ['nifty_buy_range_breakout']))).toEqual([
      'list:C',
      'nifty_buy_range_breakout',
    ]);
    expect(favouriteSelectors(set([]))).toEqual([]);
  });

  it('keeps a hidden list star saved but opens nothing on it (only Adaptive is shown)', () => {
    for (const hidden of ['A', 'B', 'REF'] as const) expect(listSelector(hidden)).toBeNull();
    // the star itself survives a toggle of another list: the server's record is not rewritten
    expect(toggleList(set(['A', 'REF']), 'C').lists).toEqual(['A', 'C', 'REF']);
    expect(favouriteSelectors(set(['A', 'B', 'REF']))).toEqual([]);
  });

  it('copies a server answer into a set', () => {
    const copy = setOf({ lists: ['A'], strategies: ['x'] });
    expect(copy).toEqual({ lists: ['A'], strategies: ['x'] });
  });
});

describe('correlateHref', () => {
  it('compares an item with the starred ones, the item first and never twice', () => {
    expect(correlateHref('list:C', set(['C'], ['x', 'y']))).toBe(
      '/optionslab/correlation?names=list%3AC,x,y',
    );
    expect(correlateHref('x', set(['C'], ['x']))).toBe('/optionslab/correlation?names=x,list%3AC');
  });

  it('never brings a hidden list into the comparison, even when it is starred', () => {
    expect(correlateHref('x', set(['A', 'B', 'REF'], ['x']))).toBe(
      '/optionslab/correlation?names=x,list%3AC',
    );
  });

  it('pairs a lone item with Adaptive, or with the base Widesl when it is Adaptive', () => {
    expect(correlateHref('x', set([], []))).toBe('/optionslab/correlation?names=x,list%3AC');
    expect(correlateHref('list:C', set([], []))).toBe(
      '/optionslab/correlation?names=list%3AC,N_wide_0917',
    );
  });
});
