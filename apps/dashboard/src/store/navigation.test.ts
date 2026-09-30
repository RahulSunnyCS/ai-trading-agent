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
    expect(firstVisibleTab({
      order: DEFAULT_NAVIGATION_PREFERENCES.order,
      hidden: DEFAULT_NAVIGATION_PREFERENCES.order,
    })).toBe('settings');
  });
});
