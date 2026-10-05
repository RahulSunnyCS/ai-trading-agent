import { create } from 'zustand';

import { NAV_GROUPS, type Tab } from '../components/shell/nav';

/**
 * Dashboard settings that live only in this browser: table density, the defaults a fresh visit
 * starts from, the developer flag and the local notification toggles.
 *
 * SSR-safe in the same way as `store/theme.ts`: the store starts from fixed defaults on the
 * server and on the client's first render, and `hydrateSettingsFromStorage()` applies the stored
 * values from an effect after mount.
 */
export type Density = 'comfortable' | 'compact';
export type MomentumDefaultDataset = 'etf' | 'broad';

/** `dateRangeYears` value that means "the full history". */
export const FULL_HISTORY_YEARS = 0;
/** The periods the Defaults section offers, in years (`FULL_HISTORY_YEARS` = everything). */
export const DATE_RANGE_YEAR_CHOICES: readonly number[] = [1, 3, 5, FULL_HISTORY_YEARS];

export interface SettingsDefaults {
  /** Tab a visit to "/" opens; null = the app's own default. */
  landingTab: Tab | null;
  /** Dataset Momentum opens on; null = the app's own default. */
  momentumDataset: MomentumDefaultDataset | null;
  /** Default backtest period in years (`FULL_HISTORY_YEARS` = full history); null = app default. */
  dateRangeYears: number | null;
}

export interface SettingsNotifications {
  /** Warn in the dashboard before the Fyers token expires. Local only; no server setting. */
  tokenExpiry: boolean;
}

export interface Settings {
  density: Density;
  defaults: SettingsDefaults;
  /** Reveals the pending-work notes (`PendingInfo`) in each tab's header. */
  developer: boolean;
  notifications: SettingsNotifications;
}

export const SETTINGS_STORAGE_KEY = 'ata.settings.v1';
const DENSITY_CLASS = 'density-compact';

export const DEFAULT_SETTINGS: Settings = {
  density: 'comfortable',
  defaults: { landingTab: null, momentumDataset: null, dateRangeYears: null },
  developer: false,
  notifications: { tokenExpiry: true },
};

function knownTabs(): ReadonlySet<string> {
  return new Set(NAV_GROUPS.flatMap((group) => group.items).map((item) => item.id));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Any stored value → valid settings. Each field falls back to its default on its own, so one
 * bad field does not discard the rest; a tab id that no longer exists is dropped.
 */
export function normalizeSettings(
  value: unknown,
  tabs: ReadonlySet<string> = knownTabs(),
): Settings {
  const raw = asRecord(value);
  const defaults = asRecord(raw.defaults);
  const notifications = asRecord(raw.notifications);
  const landingTab = defaults.landingTab;
  const dataset = defaults.momentumDataset;
  const years = defaults.dateRangeYears;
  return {
    density: raw.density === 'compact' ? 'compact' : 'comfortable',
    defaults: {
      landingTab:
        typeof landingTab === 'string' && tabs.has(landingTab) ? (landingTab as Tab) : null,
      momentumDataset: dataset === 'etf' || dataset === 'broad' ? dataset : null,
      dateRangeYears:
        typeof years === 'number' && DATE_RANGE_YEAR_CHOICES.includes(years) ? years : null,
    },
    developer: raw.developer === true,
    notifications: {
      tokenExpiry:
        typeof notifications.tokenExpiry === 'boolean'
          ? notifications.tokenExpiry
          : DEFAULT_SETTINGS.notifications.tokenExpiry,
    },
  };
}

/** The raw localStorage string → settings; nothing stored or unparseable JSON gives the defaults. */
export function parseStoredSettings(
  stored: string | null,
  tabs: ReadonlySet<string> = knownTabs(),
): Settings {
  if (!stored) return DEFAULT_SETTINGS;
  try {
    return normalizeSettings(JSON.parse(stored), tabs);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function applyDensity(density: Density): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(DENSITY_CLASS, density === 'compact');
}

function persist(settings: Settings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: the setting still applies for this visit.
  }
}

interface SettingsState extends Settings {
  setDensity: (density: Density) => void;
  setDefaults: (patch: Partial<SettingsDefaults>) => void;
  setDeveloper: (developer: boolean) => void;
  setNotifications: (patch: Partial<SettingsNotifications>) => void;
}

function snapshot(state: SettingsState): Settings {
  return {
    density: state.density,
    defaults: state.defaults,
    developer: state.developer,
    notifications: state.notifications,
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  function update(patch: Partial<Settings>): void {
    set(patch);
    persist(snapshot(get()));
  }
  return {
    ...DEFAULT_SETTINGS,
    setDensity: (density) => {
      applyDensity(density);
      update({ density });
    },
    setDefaults: (patch) => update({ defaults: { ...get().defaults, ...patch } }),
    setDeveloper: (developer) => update({ developer }),
    setNotifications: (patch) => update({ notifications: { ...get().notifications, ...patch } }),
  };
});

/** Client-only, post-mount: applies the stored settings. Never call during render or SSR. */
export function hydrateSettingsFromStorage(): void {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
  } catch {
    stored = null;
  }
  const settings = parseStoredSettings(stored);
  applyDensity(settings.density);
  useSettingsStore.setState(settings);
}

/** Non-reactive reads for code that needs a default once (call after hydration). */
export function getLandingTab(): Tab | null {
  return useSettingsStore.getState().defaults.landingTab;
}

export function getDefaultMomentumDataset(): MomentumDefaultDataset | null {
  return useSettingsStore.getState().defaults.momentumDataset;
}

/** Years of history a backtest starts with; `FULL_HISTORY_YEARS` = everything, null = app default. */
export function getDefaultDateRangeYears(): number | null {
  return useSettingsStore.getState().defaults.dateRangeYears;
}
