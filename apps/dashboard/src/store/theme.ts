import { create } from 'zustand';

/**
 * UI theme store. Persists the user's choice to localStorage, seeds from the
 * OS preference on first visit, and keeps the `.dark` class on <html> in sync
 * so the token system (index.css) resolves to the right palette.
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
 * interactive if the stored/OS preference differs from the default below.
 */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ata-theme';
const DEFAULT_THEME: Theme = 'dark';

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

applyTheme(DEFAULT_THEME);

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: DEFAULT_THEME,
  setTheme: (theme) => {
    applyTheme(theme);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, theme);
    }
    set({ theme });
  },
  toggleTheme: () => {
    get().setTheme(get().theme === 'dark' ? 'light' : 'dark');
  },
}));

/** Client-only, post-mount: applies the real stored/OS preference if it
 * differs from DEFAULT_THEME. Never call this during render or SSR. */
export function hydrateThemeFromStorage(): void {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  const preferred: Theme =
    stored === 'light' || stored === 'dark'
      ? stored
      : window.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  if (preferred !== useThemeStore.getState().theme) {
    useThemeStore.getState().setTheme(preferred);
  }
}
