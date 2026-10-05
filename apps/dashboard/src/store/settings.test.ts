import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  FULL_HISTORY_YEARS,
  getDefaultDateRangeYears,
  getDefaultMomentumDataset,
  getLandingTab,
  normalizeSettings,
  parseStoredSettings,
  useSettingsStore,
} from './settings';

const TABS = new Set(['live', 'momentum', 'settings']);

describe('settings parsing', () => {
  it('gives the defaults when nothing is stored', () => {
    expect(parseStoredSettings(null, TABS)).toEqual(DEFAULT_SETTINGS);
    expect(parseStoredSettings('', TABS)).toEqual(DEFAULT_SETTINGS);
  });

  it('gives the defaults for unparseable JSON', () => {
    expect(parseStoredSettings('{not json', TABS)).toEqual(DEFAULT_SETTINGS);
  });

  it.each([null, 42, 'compact', [], [{ density: 'compact' }]])(
    'gives the defaults for a non-object value (%j)',
    (value) => {
      expect(normalizeSettings(value, TABS)).toEqual(DEFAULT_SETTINGS);
    },
  );

  it('keeps a complete valid value', () => {
    const stored = {
      density: 'compact',
      defaults: { landingTab: 'momentum', momentumDataset: 'broad', dateRangeYears: 3 },
      developer: true,
      notifications: { tokenExpiry: false },
    };
    expect(parseStoredSettings(JSON.stringify(stored), TABS)).toEqual(stored);
  });

  it('falls back field by field, keeping the valid ones', () => {
    const result = normalizeSettings(
      {
        density: 'cosy',
        defaults: { landingTab: 'momentum', momentumDataset: 'stock', dateRangeYears: '3' },
        developer: 'yes',
        notifications: { tokenExpiry: 'no' },
      },
      TABS,
    );
    expect(result).toEqual({
      ...DEFAULT_SETTINGS,
      defaults: { landingTab: 'momentum', momentumDataset: null, dateRangeYears: null },
    });
  });

  it('drops a landing tab that no longer exists', () => {
    const result = normalizeSettings({ defaults: { landingTab: 'removedTab' } }, TABS);
    expect(result.defaults.landingTab).toBeNull();
  });

  it('accepts only the offered periods, including full history', () => {
    const years = (value: unknown) =>
      normalizeSettings({ defaults: { dateRangeYears: value } }, TABS).defaults.dateRangeYears;
    expect(years(1)).toBe(1);
    expect(years(5)).toBe(5);
    expect(years(FULL_HISTORY_YEARS)).toBe(FULL_HISTORY_YEARS);
    expect(years(2)).toBeNull();
    expect(years(-1)).toBeNull();
    expect(years(Number.NaN)).toBeNull();
  });

  it('tolerates malformed nested sections', () => {
    expect(normalizeSettings({ defaults: 'x', notifications: [] }, TABS)).toEqual(DEFAULT_SETTINGS);
  });

  it('validates against the real navigation when no tab set is passed', () => {
    expect(normalizeSettings({ defaults: { landingTab: 'settings' } }).defaults.landingTab).toBe(
      'settings',
    );
    expect(
      normalizeSettings({ defaults: { landingTab: 'no-such-tab' } }).defaults.landingTab,
    ).toBeNull();
  });
});

describe('settings store', () => {
  it('starts from the fixed defaults (the SSR first render)', () => {
    const state = useSettingsStore.getState();
    expect(state.density).toBe('comfortable');
    expect(state.developer).toBe(false);
    expect(state.notifications.tokenExpiry).toBe(true);
    expect(getLandingTab()).toBeNull();
    expect(getDefaultMomentumDataset()).toBeNull();
    expect(getDefaultDateRangeYears()).toBeNull();
  });

  it('setters merge patches and the selectors read them back', () => {
    const store = useSettingsStore.getState();
    store.setDefaults({ momentumDataset: 'broad' });
    store.setDefaults({ dateRangeYears: 5 });
    store.setDeveloper(true);
    store.setNotifications({ tokenExpiry: false });
    store.setDensity('compact');

    expect(getDefaultMomentumDataset()).toBe('broad');
    expect(getDefaultDateRangeYears()).toBe(5);
    expect(getLandingTab()).toBeNull();
    const state = useSettingsStore.getState();
    expect(state.developer).toBe(true);
    expect(state.notifications.tokenExpiry).toBe(false);
    expect(state.density).toBe('compact');

    useSettingsStore.setState(DEFAULT_SETTINGS);
  });
});
