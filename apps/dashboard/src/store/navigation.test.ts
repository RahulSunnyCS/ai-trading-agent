import { describe, expect, it } from 'vitest';

import { ARCHIVED_TABS } from '../components/shell/nav';
import {
  DEFAULT_NAVIGATION_PREFERENCES,
  NAVIGATION_VERSION,
  firstVisibleTab,
  migrateNavigationPreferences,
  moveTabBefore,
  normalizeNavigationPreferences,
  visibleNavigationGroups,
} from './navigation';

/** Every tab shown: the archived ones included. */
const ALL_SHOWN = { ...DEFAULT_NAVIGATION_PREFERENCES, hidden: [] };

function groupIds(preferences: Parameters<typeof visibleNavigationGroups>[0]) {
  return visibleNavigationGroups(preferences).map((group) => [
    group.id,
    group.items.map((item) => item.id),
  ]);
}

describe('navigation preferences', () => {
  it('repairs stale values and adds newly introduced tabs', () => {
    const result = normalizeNavigationPreferences({
      hidden: ['live', 'removed', 'live'],
      order: ['momentum', 'removed', 'live', 'momentum'],
    });

    expect(result.hidden).toEqual(['live']);
    // Stored tabs keep their relative order; Overview, new to this value, leads.
    expect(result.order[0]).toBe('overview');
    expect(result.order.indexOf('momentum')).toBeLessThan(result.order.indexOf('live'));
    expect(result.order).toHaveLength(DEFAULT_NAVIGATION_PREFERENCES.order.length);
    // A tab the value lacks goes after the tab before it in the default order.
    expect(result.order.indexOf('tradebook')).toBe(result.order.indexOf('momentum') + 1);
    expect(new Set(result.order)).toEqual(new Set(DEFAULT_NAVIGATION_PREFERENCES.order));
    expect(result.order).toContain('brokerLogins');
  });

  it('keeps Settings and the Guide visible and pinned at the end of Operations', () => {
    const groups = visibleNavigationGroups({
      ...DEFAULT_NAVIGATION_PREFERENCES,
      hidden: ['live', 'jobs'],
    });
    const ids = groups.flatMap((group) => group.items.map((item) => item.id));

    expect(ids).not.toContain('live');
    expect(ids).not.toContain('jobs');
    expect(groups.find((group) => group.id === 'operations')?.items.map((i) => i.id)).toEqual([
      'brokerLogins',
      'settings',
      'guide',
    ]);
  });

  it('never lets the Guide be hidden or reordered away', () => {
    const preferences = normalizeNavigationPreferences({
      hidden: ['guide', 'settings'],
      order: ['guide', 'overview'],
    });
    expect(preferences.hidden).toEqual([]);
    expect(preferences.order as string[]).not.toContain('guide');
    const operations = visibleNavigationGroups(preferences).find((g) => g.id === 'operations');
    expect(operations?.items.at(-1)?.id).toBe('guide');
    expect(operations?.items.at(-2)?.id).toBe('settings');
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

  it('defaults to the daily sections first and the Archived engine hidden', () => {
    expect(DEFAULT_NAVIGATION_PREFERENCES.order).toEqual([
      'overview',
      'optionslab',
      'live',
      'momentum',
      'tradebook',
      'jobs',
      'brokerLogins',
      'trades',
      'pnl',
      'personalities',
      'regime',
      'coverage',
      'pricing',
    ]);
    expect(DEFAULT_NAVIGATION_PREFERENCES.hidden).toEqual([...ARCHIVED_TABS]);
    expect(ARCHIVED_TABS).toEqual([
      'trades',
      'pnl',
      'personalities',
      'regime',
      'coverage',
      'pricing',
    ]);
    expect(groupIds(DEFAULT_NAVIGATION_PREFERENCES)).toEqual([
      ['overview', ['overview']],
      ['optionslab', ['optionslab', 'live']],
      ['momentum', ['momentum']],
      ['tradebook', ['tradebook']],
      ['operations', ['jobs', 'brokerLogins', 'settings', 'guide']],
    ]);
  });

  it('shows the Archived engine section once its tabs are shown', () => {
    expect(groupIds(ALL_SHOWN).at(-1)).toEqual([
      'archived',
      ['trades', 'pnl', 'personalities', 'regime', 'coverage', 'pricing'],
    ]);
  });

  it('keeps the open tab in the sidebar even while it is hidden', () => {
    const groups = visibleNavigationGroups(DEFAULT_NAVIGATION_PREFERENCES, 'pnl');
    expect(groups.at(-1)?.id).toBe('archived');
    expect(groups.at(-1)?.items.map((item) => item.id)).toEqual(['pnl']);
  });

  // The YAML backtest tab was retired into Options Lab. A browser that hid it, or ranked it
  // first, must load without error and must not lose Options Lab.
  it('drops the retired backtest tab from stored preferences', () => {
    const hiddenOnly = normalizeNavigationPreferences({ hidden: ['backtest'], order: [] });
    expect(hiddenOnly).toEqual(ALL_SHOWN);

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
      order: DEFAULT_NAVIGATION_PREFERENCES.order.filter((id) => id !== 'optionslab'),
    });
    expect(hidden.hidden).toEqual(['overview']);
    expect(hidden.order.slice(0, 3)).toEqual(['overview', 'optionslab', 'live']);
    expect(firstVisibleTab(hidden)).toBe('optionslab');
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
    expect(moved.order[0]).toBe('optionslab');
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
      hidden: [...ARCHIVED_TABS, 'tradebook'],
    });
    expect(groups.map((group) => group.id)).toEqual([
      'overview',
      'optionslab',
      'momentum',
      'operations',
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
  });

  // Version 2 added the Archived engine section, hidden by default. A browser holds whatever an
  // earlier version saved; the migration must hide the archived tabs once and then leave the
  // reader's later choices alone.
  describe('the version 2 migration (Archived engine)', () => {
    // A browser that saved the old defaults: the old flat order, nothing hidden, no version.
    const OLD_DEFAULTS = {
      hidden: [],
      order: [
        'overview',
        'live',
        'trades',
        'pnl',
        'personalities',
        'regime',
        'optionslab',
        'momentum',
        'tradebook',
        'coverage',
        'jobs',
        'brokerLogins',
        'pricing',
      ],
    };

    it('hides the archived tabs once in a value saved before version 2', () => {
      const migrated = migrateNavigationPreferences(OLD_DEFAULTS);
      expect(new Set(migrated.hidden)).toEqual(new Set(ARCHIVED_TABS));
      expect(groupIds(migrated)).toEqual(groupIds(DEFAULT_NAVIGATION_PREFERENCES));
      expect(firstVisibleTab(migrated)).toBe('overview');
    });

    it('moves Live after Options Lab, keeps the reader’s own hidden tabs and drags', () => {
      const migrated = migrateNavigationPreferences({
        hidden: ['momentum', 'backfill', 'replay'],
        order: ['pnl', 'live', 'trades', 'optionslab', 'brokerLogins', 'jobs'],
      });
      expect(migrated.hidden).toEqual(
        expect.arrayContaining(['momentum', 'coverage', ...ARCHIVED_TABS]),
      );
      expect(migrated.order.indexOf('live')).toBe(migrated.order.indexOf('optionslab') + 1);
      // Broker logins dragged above Jobs stays above it in the Operations section.
      expect(
        visibleNavigationGroups(migrated)
          .find((g) => g.id === 'operations')
          ?.items.map((i) => i.id),
      ).toEqual(['brokerLogins', 'jobs', 'settings', 'guide']);
    });

    it('respects an archived tab shown again after the upgrade', () => {
      // What saveNavigationPreferences writes after the reader shows Trades in Settings.
      const saved = JSON.parse(
        JSON.stringify({
          version: NAVIGATION_VERSION,
          hidden: ARCHIVED_TABS.filter((id) => id !== 'trades'),
          order: DEFAULT_NAVIGATION_PREFERENCES.order,
        }),
      );
      const loaded = migrateNavigationPreferences(saved);
      expect(loaded.hidden).not.toContain('trades');
      expect(
        visibleNavigationGroups(loaded)
          .find((g) => g.id === 'archived')
          ?.items.map((i) => i.id),
      ).toEqual(['trades']);
      // Loading it again changes nothing.
      expect(migrateNavigationPreferences({ version: NAVIGATION_VERSION, ...loaded })).toEqual(
        loaded,
      );
    });

    it('treats an unreadable value as an old one and still hides the archive', () => {
      expect(migrateNavigationPreferences(null)).toEqual(DEFAULT_NAVIGATION_PREFERENCES);
      expect(migrateNavigationPreferences({ version: 'two' }).hidden).toEqual([...ARCHIVED_TABS]);
    });
  });
});
