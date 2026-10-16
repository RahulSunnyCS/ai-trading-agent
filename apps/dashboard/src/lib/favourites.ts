/**
 * Favourites (BL-102): which rotation lists and strategies the owner starred on Strategies and
 * baskets. The server keeps them (`GET`/`PUT /legwise/favourites`); this is the pure side:
 * toggling, canonical order and the default selection a picker starts from.
 */

import type { FavouriteListKey, Favourites } from '../types/legwise';
import { DEFAULT_LIST, isVisibleList } from './rotationListNames';

/** Canonical order, the same as the server's: lists never reorder when starred. */
export const FAVOURITE_LIST_KEYS: readonly FavouriteListKey[] = ['A', 'B', 'C', 'REF', 'base'];

/** What a PUT carries. */
export interface FavouriteSet {
  lists: FavouriteListKey[];
  strategies: string[];
}

export function setOf(favourites: Pick<Favourites, 'lists' | 'strategies'>): FavouriteSet {
  return { lists: [...favourites.lists], strategies: [...favourites.strategies] };
}

export function isListStarred(set: FavouriteSet, key: FavouriteListKey): boolean {
  return set.lists.includes(key);
}

export function isStrategyStarred(set: FavouriteSet, name: string): boolean {
  return set.strategies.includes(name);
}

/** The set with `key` starred or un-starred; lists stay in canonical order. */
export function toggleList(set: FavouriteSet, key: FavouriteListKey): FavouriteSet {
  const has = set.lists.includes(key);
  const wanted = new Set(has ? set.lists.filter((k) => k !== key) : [...set.lists, key]);
  return { lists: FAVOURITE_LIST_KEYS.filter((k) => wanted.has(k)), strategies: set.strategies };
}

/** The set with the strategy starred (appended) or un-starred. */
export function toggleStrategy(set: FavouriteSet, name: string): FavouriteSet {
  const has = set.strategies.includes(name);
  return {
    lists: set.lists,
    strategies: has ? set.strategies.filter((n) => n !== name) : [...set.strategies, name],
  };
}

/**
 * A rotation list as a Correlation selector (`list:C`). The fixed base has none yet, and a list
 * the dashboard does not show (`VISIBLE_LIST_KEYS`) has none either: its star stays saved on the
 * server, but nothing opens on it.
 */
export function listSelector(key: FavouriteListKey): string | null {
  return key === 'base' || !isVisibleList(key) ? null : `list:${key}`;
}

/**
 * The selectors a picker opens on: the starred shown lists that can be correlated, then the
 * starred strategies. An empty result means nothing is starred, so the page falls back to its own
 * default.
 */
export function favouriteSelectors(set: FavouriteSet): string[] {
  const lists = set.lists.map(listSelector).filter((s): s is string => s !== null);
  return [...lists, ...set.strategies];
}

/**
 * The Correlation address that compares `item` (a `list:C` selector or a strategy name) with the
 * other starred items. A comparison needs two, so a lone item is paired with the first shown list
 * (or, when the item is that list, with N_wide_0917, the fixed base's Widesl OTM1 09:17).
 */
export function correlateHref(item: string, set: FavouriteSet): string {
  const names = [item, ...favouriteSelectors(set).filter((s) => s !== item)];
  const shown = `list:${DEFAULT_LIST}`;
  if (names.length < 2) names.push(item === shown ? 'N_wide_0917' : shown);
  return `/optionslab/correlation?names=${names.map(encodeURIComponent).join(',')}`;
}
