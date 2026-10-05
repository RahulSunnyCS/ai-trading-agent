import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NAVIGATION_PREFERENCES,
  firstVisibleTab,
  moveTabBefore,
  normalizeNavigationPreferences,
  visibleNavigationGroups,
} from './navigation';

describe('navigation preferences', () => {
  it('repairs stale values and appends newly introduced tabs', () => {
    const result = normalizeNavigationPreferences({
      hidden: ['live', 'removed', 'live'],
      order: ['momentum', 'removed', 'live', 'momentum'],
    });

    expect(result.hidden).toEqual(['live']);
    expect(result.order.slice(0, 2)).toEqual(['momentum', 'live']);
    expect(new Set(result.order)).toEqual(new Set(DEFAULT_NAVIGATION_PREFERENCES.order));
    expect(result.order).toContain('brokerLogins');
  });

  it('keeps Settings visible and pinned while hiding optional tabs', () => {
    const groups = visibleNavigationGroups({
      ...DEFAULT_NAVIGATION_PREFERENCES,
      hidden: ['live', 'pricing'],
    });
    const ids = groups.flatMap((group) => group.items.map((item) => item.id));

    expect(ids).not.toContain('live');
    expect(ids).not.toContain('pricing');
    expect(ids.at(-1)).toBe('settings');
  });

  it('reorders a tab before its drop target', () => {
    expect(moveTabBefore(['live', 'trades', 'pnl'], 'pnl', 'live')).toEqual([
      'pnl',
      'live',
      'trades',
    ]);
  });

  it('falls back to Settings if every optional tab is hidden', () => {
    expect(
      firstVisibleTab({
        order: DEFAULT_NAVIGATION_PREFERENCES.order,
        hidden: DEFAULT_NAVIGATION_PREFERENCES.order,
      }),
    ).toBe('settings');
  });

  // What a browser holds from before the regroup: the flat order of the old
  // Trading / Research / Account groups, here with the user's own changes
  // (P&L dragged above Live, Replay above Backfill) and three hidden tabs.
  it('keeps hidden tabs and relative order from a value stored under the old grouping', () => {
    const stored = JSON.parse(
      JSON.stringify({
        hidden: ['personalities', 'backtest', 'pricing'],
        order: [
          'pnl',
          'live',
          'trades',
          'personalities',
          'regime',
          'replay',
          'backfill',
          'backtest',
          'optionslab',
          'momentum',
          'brokerLogins',
          'pricing',
        ],
      }),
    );

    const preferences = normalizeNavigationPreferences(stored);
    expect(preferences).toEqual(stored);

    const groups = visibleNavigationGroups(preferences);
    expect(groups.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ['live', ['pnl', 'live', 'trades', 'regime']],
      ['optionslab', ['optionslab']],
      ['momentum', ['momentum']],
      ['data', ['replay', 'backfill']],
      ['account', ['brokerLogins', 'settings']],
    ]);
    expect(firstVisibleTab(preferences)).toBe('pnl');
  });

  it('drops a group whose tabs are all hidden', () => {
    const groups = visibleNavigationGroups({
      ...DEFAULT_NAVIGATION_PREFERENCES,
      hidden: ['backfill', 'replay'],
    });
    expect(groups.map((group) => group.id)).toEqual(['live', 'optionslab', 'momentum', 'account']);
  });

  it('defaults to the product grouping order', () => {
    expect(DEFAULT_NAVIGATION_PREFERENCES.order).toEqual([
      'live',
      'trades',
      'pnl',
      'personalities',
      'regime',
      'optionslab',
      'backtest',
      'momentum',
      'backfill',
      'replay',
      'brokerLogins',
      'pricing',
    ]);
  });
});
