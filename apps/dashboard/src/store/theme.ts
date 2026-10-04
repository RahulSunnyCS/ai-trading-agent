import { create } from 'zustand';

/**
 * UI theme store. The user picks a *preference* — light, dark, or follow the OS — which
 * resolves to the *theme* actually applied (`.dark` on <html>, so the tokens in index.css
 * resolve to the right palette). The preference persists to localStorage; a first-time
 * visitor gets dark.
 *
 * Under Next.js SSR, the server has no access to localStorage/matchMedia, so
 * it cannot know the real preference — the initial state MUST be the same
 * fixed value on the server and on the client's first render, or React's
 * hydration throws (this used to read window/localStorage directly here,
 * which returned 'dark' on the server and the real preference on the
 * client — a guaranteed mismatch whenever the real preference was 'light').
 * `hydrateThemeFromStorage()` applies the real preference once, from a
 * client-only effect AFTER mount (see App.tsx) — by then hydration is done,
 * so this is an ordinary state update, not a server/client mismatch. It can
 * cause one harmless flip of the icon/palette right after the page becomes
 * interactive if the stored preference resolves to something other than the default below.
 */
export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

const STORAGE_KEY = 'ata-theme';
const DEFAULT_THEME: Theme = 'dark';

function systemTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return DEFAULT_THEME;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The theme a preference resolves to right now. */
export function resolveTheme(preference: ThemePreference, system: Theme = systemTheme()): Theme {
  return preference === 'system' ? system : preference;
}

/** A stored value → preference; anything unknown (or nothing stored) is the dark default. */
export function parseStoredPreference(stored: string | null): ThemePreference {
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : DEFAULT_THEME;
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
}

interface ThemeState {
  /** The resolved theme currently applied. Charts use it as their recolour key. */
  theme: Theme;
  /** What the user chose: an explicit theme, or 'system' to follow the OS. */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /** Shortcut for an explicit choice (the top-bar toggle). */
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

applyTheme(DEFAULT_THEME);

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: DEFAULT_THEME,
  preference: DEFAULT_THEME,
  setPreference: (preference) => {
    const theme = resolveTheme(preference);
    applyTheme(theme);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, preference);
    }
    set({ theme, preference });
  },
  setTheme: (theme) => get().setPreference(theme),
  toggleTheme: () => {
    get().setPreference(get().theme === 'dark' ? 'light' : 'dark');
  },
}));

let watchingSystem = false;

/** Client-only, post-mount: applies the stored preference (dark when nothing is stored) and
 * follows OS changes while the preference is 'system'. Never call this during render or SSR. */
export function hydrateThemeFromStorage(): void {
  const preference = parseStoredPreference(window.localStorage.getItem(STORAGE_KEY));
  const theme = resolveTheme(preference);
  const state = useThemeStore.getState();
  if (preference !== state.preference || theme !== state.theme) {
    applyTheme(theme);
    useThemeStore.setState({ theme, preference });
  }
  if (!watchingSystem && window.matchMedia) {
    watchingSystem = true;
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (useThemeStore.getState().preference !== 'system') return;
      const next = systemTheme();
      applyTheme(next);
      useThemeStore.setState({ theme: next });
    });
  }
}
