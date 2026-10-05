import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NAVIGATION_PREFERENCES,
  firstVisibleTab,
  moveTabBefore,
  normalizeNavigationPreferences,
  visibleNavigationGroups,
} from './navigation';

describe('navigation preferences', () => {
  it('repairs stale values and adds newly introduced tabs', () => {
    const result = normalizeNavigationPreferences({
      hidden: ['live', 'removed', 'live'],
      order: ['momentum', 'removed', 'live', 'momentum'],
    });

    expect(result.hidden).toEqual(['live']);
    // Stored tabs keep their relative order; Overview, new to this value, leads.
    expect(result.order.slice(0, 2)).toEqual(['overview', 'momentum']);
    expect(result.order.indexOf('momentum')).toBeLessThan(result.order.indexOf('live'));
    expect(result.order).toHaveLength(DEFAULT_NAVIGATION_PREFERENCES.order.length);
    expect(result.order.indexOf('trades')).toBe(result.order.indexOf('live') + 1);
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

    // Overview did not exist when this value was stored: it is added first. `backtest` is no
    // longer a tab (it is Options Lab › Builder › YAML), so it leaves both lists. Replay and
    // Backfill merged into Coverage, which takes Replay's place (it ranked first). Nothing
    // else about the value changes.
    const preferences = normalizeNavigationPreferences(stored);
    expect(preferences).toEqual({
      hidden: ['personalities', 'pricing'],
      order: [
        'overview',
        'pnl',
        'live',
        'trades',
        'personalities',
        'regime',
        'coverage',
        'optionslab',
        'momentum',
        'brokerLogins',
        'pricing',
      ],
    });

    const groups = visibleNavigationGroups(preferences);
    expect(groups.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ['overview', ['overview']],
      ['live', ['pnl', 'live', 'trades', 'regime']],
      ['optionslab', ['optionslab']],
      ['momentum', ['momentum']],
      ['data', ['coverage']],
      ['account', ['brokerLogins', 'settings']],
    ]);
    // Overview is the landing tab even for a browser whose stored order began with another.
    expect(firstVisibleTab(preferences)).toBe('overview');
  });

  // The YAML backtest tab was retired into Options Lab. A browser that hid it, or ranked it
  // first, must load without error and must not lose Options Lab.
  it('drops the retired backtest tab from stored preferences', () => {
    const hiddenOnly = normalizeNavigationPreferences({ hidden: ['backtest'], order: [] });
    expect(hiddenOnly).toEqual(DEFAULT_NAVIGATION_PREFERENCES);

    const preferences = normalizeNavigationPreferences({
      hidden: ['backtest', 'personalities'],
      order: ['backtest', 'optionslab', 'live', 'backtest'],
    });
    expect(preferences.hidden).toEqual(['personalities']);
    expect(preferences.order as string[]).not.toContain('backtest');
    expect(new Set(preferences.order)).toEqual(new Set(DEFAULT_NAVIGATION_PREFERENCES.order));
    expect(preferences.order.indexOf('optionslab')).toBeLessThan(preferences.order.indexOf('live'));

    const ids = visibleNavigationGroups(preferences).flatMap((group) =>
      group.items.map((item) => item.id),
    );
    expect(ids).toContain('optionslab');
    expect(ids as string[]).not.toContain('backtest');
    // Normalising what was just normalised changes nothing.
    expect(normalizeNavigationPreferences(preferences)).toEqual(preferences);
  });

  it('lands on Overview by default, and on the next tab in order when Overview is hidden', () => {
    expect(firstVisibleTab(DEFAULT_NAVIGATION_PREFERENCES)).toBe('overview');
    const hidden = normalizeNavigationPreferences({
      hidden: ['overview'],
      order: DEFAULT_NAVIGATION_PREFERENCES.order.filter((id) => id !== 'live'),
    });
    expect(hidden.hidden).toEqual(['overview']);
    expect(hidden.order.slice(0, 3)).toEqual(['overview', 'live', 'trades']);
    expect(firstVisibleTab(hidden)).toBe('live');
  });

  it('keeps a stored position for Overview once the value has one', () => {
    const moved = normalizeNavigationPreferences({
      hidden: [],
      order: [
        ...DEFAULT_NAVIGATION_PREFERENCES.order.filter((id) => id !== 'overview'),
        'overview',
      ],
    });
    expect(moved.order.at(-1)).toBe('overview');
    expect(moved.order[0]).toBe('live');
  });

  it('places a tab missing from the middle of a stored order after its default neighbour', () => {
    const result = normalizeNavigationPreferences({
      hidden: [],
      order: DEFAULT_NAVIGATION_PREFERENCES.order.filter((id) => id !== 'pnl').reverse(),
    });
    expect(result.order.indexOf('pnl')).toBe(result.order.indexOf('trades') + 1);
  });

  it('drops a group whose tabs are all hidden', () => {
    const groups = visibleNavigationGroups({
      ...DEFAULT_NAVIGATION_PREFERENCES,
      hidden: ['coverage'],
    });
    expect(groups.map((group) => group.id)).toEqual([
      'overview',
      'live',
      'optionslab',
      'momentum',
      'account',
    ]);
  });

  it('defaults to the product grouping order', () => {
    expect(DEFAULT_NAVIGATION_PREFERENCES.order).toEqual([
      'overview',
      'live',
      'trades',
      'pnl',
      'personalities',
      'regime',
      'optionslab',
      'momentum',
      'coverage',
      'brokerLogins',
      'pricing',
    ]);
  });

  // Backfill and Replay became the two sections of Coverage (BL-013 Phase 8).
  describe('the Backfill and Replay tabs merged into Coverage', () => {
    it('hides Coverage only when both old tabs were hidden', () => {
      expect(normalizeNavigationPreferences({ hidden: ['backfill', 'replay'] }).hidden).toEqual([
        'coverage',
      ]);
      expect(
        normalizeNavigationPreferences({ hidden: ['replay', 'live', 'backfill'] }).hidden,
      ).toEqual(['coverage', 'live']);
    });

    it('keeps Coverage visible when only one of them was hidden', () => {
      expect(normalizeNavigationPreferences({ hidden: ['backfill'] }).hidden).toEqual([]);
      expect(normalizeNavigationPreferences({ hidden: ['replay', 'trades'] }).hidden).toEqual([
        'trades',
      ]);
    });

    it('puts Coverage where the first of the old ids ranked, once', () => {
      const result = normalizeNavigationPreferences({
        hidden: [],
        order: ['backfill', 'live', 'replay', 'trades'],
      });
      expect(result.order[1]).toBe('coverage');
      expect(result.order.indexOf('coverage')).toBeLessThan(result.order.indexOf('live'));
      expect(result.order.indexOf('live')).toBeLessThan(result.order.indexOf('trades'));
      expect(result.order.filter((id) => id === 'coverage')).toHaveLength(1);
      expect(new Set(result.order)).toEqual(new Set(DEFAULT_NAVIGATION_PREFERENCES.order));
    });

    it('loads a value that names the old ids and the new one, and re-normalises to itself', () => {
      const result = normalizeNavigationPreferences({
        hidden: ['coverage', 'replay'],
        order: ['replay', 'coverage', 'backfill'],
      });
      expect(result.hidden).toEqual(['coverage']);
      expect(result.order as string[]).not.toContain('backfill');
      expect(result.order as string[]).not.toContain('replay');
      expect(normalizeNavigationPreferences(result)).toEqual(result);
    });

    it('lands on the next visible tab when Coverage starts hidden', () => {
      const result = normalizeNavigationPreferences({
        hidden: [
          'overview',
          'live',
          'trades',
          'pnl',
          'personalities',
          'regime',
          'optionslab',
          'momentum',
          'backfill',
          'replay',
        ],
        order: [],
      });
      expect(firstVisibleTab(result)).toBe('brokerLogins');
    });
  });
});
