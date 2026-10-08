import { create } from 'zustand';

/**
 * What the reader keeps on Momentum › Saved runs, in this browser: whether the findings card is
 * hidden (BL-052). SSR-safe like `store/momentumView.ts`: the default on the server and the first
 * render, `hydrateMomentumSavedFromStorage()` from an effect after mount.
 */
export const MOMENTUM_SAVED_STORAGE_KEY = 'ata.momentumSaved.v1';

export interface MomentumSavedPrefs {
  findingsHidden: boolean;
}

export const DEFAULT_MOMENTUM_SAVED: MomentumSavedPrefs = { findingsHidden: false };

/** The raw localStorage string → preferences; nothing stored or bad JSON gives the defaults. */
export function parseStoredMomentumSaved(stored: string | null): MomentumSavedPrefs {
  if (!stored) return DEFAULT_MOMENTUM_SAVED;
  try {
    const raw = JSON.parse(stored) as Record<string, unknown> | null;
    return { findingsHidden: raw?.findingsHidden === true };
  } catch {
    return DEFAULT_MOMENTUM_SAVED;
  }
}

interface MomentumSavedState extends MomentumSavedPrefs {
  setFindingsHidden: (hidden: boolean) => void;
}

export const useMomentumSavedStore = create<MomentumSavedState>((set) => ({
  ...DEFAULT_MOMENTUM_SAVED,
  setFindingsHidden: (findingsHidden) => {
    set({ findingsHidden });
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(MOMENTUM_SAVED_STORAGE_KEY, JSON.stringify({ findingsHidden }));
    } catch {
      // Storage full or blocked: the choice still applies for this visit.
    }
  },
}));

/** Client-only, post-mount: applies the stored preference. Never call during render or SSR. */
export function hydrateMomentumSavedFromStorage(): void {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(MOMENTUM_SAVED_STORAGE_KEY);
  } catch {
    stored = null;
  }
  useMomentumSavedStore.setState(parseStoredMomentumSaved(stored));
}
