import { create } from 'zustand';

import { type StocksViewSettings, normalizeSettings } from '../lib/momentumScores';

/**
 * What the reader keeps on Momentum › Scores, remembered in this browser: named views of the
 * Stocks list (quick view, sector, search text and sort) and whether the "How to read the strip"
 * card is open. SSR-safe like `store/momentumView.ts`: fixed defaults on the server and on the
 * client's first render, `hydrateMomentumScoresViewsFromStorage()` from an effect after. The
 * Stocks list itself always opens on All; a saved view is applied only when the reader picks it.
 */
export interface SavedView {
  name: string;
  settings: StocksViewSettings;
}

export const MOMENTUM_SCORES_VIEWS_STORAGE_KEY = 'ata.momentumScoresViews.v1';
export const MAX_SAVED_VIEWS = 12;
export const MAX_VIEW_NAME = 40;

interface ScoresViewsPrefs {
  views: SavedView[];
  /** The "How to read the strip" card: open on a first visit, until the reader closes it. */
  stripHelpOpen: boolean;
}

export const DEFAULT_SCORES_VIEWS: ScoresViewsPrefs = { views: [], stripHelpOpen: true };

/** A typed name as it is stored: trimmed, inner runs of space collapsed, cut to the limit. */
export function cleanViewName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_VIEW_NAME);
}

function sameName(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/** Any stored value -> valid preferences; a bad view is dropped, a repeated name keeps the first. */
export function normalizeScoresViews(value: unknown): ScoresViewsPrefs {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const views: SavedView[] = [];
  if (Array.isArray(raw.views)) {
    for (const item of raw.views) {
      if (views.length >= MAX_SAVED_VIEWS) break;
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const name = typeof entry.name === 'string' ? cleanViewName(entry.name) : '';
      const settings = normalizeSettings(entry.settings);
      if (!name || !settings || views.some((view) => sameName(view.name, name))) continue;
      views.push({ name, settings });
    }
  }
  return { views, stripHelpOpen: raw.stripHelpOpen !== false };
}

/** The raw localStorage string -> preferences; nothing stored or bad JSON gives the defaults. */
export function parseStoredScoresViews(stored: string | null): ScoresViewsPrefs {
  if (!stored) return DEFAULT_SCORES_VIEWS;
  try {
    return normalizeScoresViews(JSON.parse(stored));
  } catch {
    return DEFAULT_SCORES_VIEWS;
  }
}

function persist(prefs: ScoresViewsPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MOMENTUM_SCORES_VIEWS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: the views still apply for this visit.
  }
}

/** What `saveView` did: a new view, one of the same name replaced, or why nothing was saved. */
export type SaveResult = 'saved' | 'replaced' | 'full' | 'empty';

interface ScoresViewsState extends ScoresViewsPrefs {
  saveView: (name: string, settings: StocksViewSettings) => SaveResult;
  deleteView: (name: string) => void;
  setStripHelpOpen: (open: boolean) => void;
}

export const useMomentumScoresViewsStore = create<ScoresViewsState>((set, get) => {
  function update(patch: Partial<ScoresViewsPrefs>): void {
    set(patch);
    const { views, stripHelpOpen } = get();
    persist({ views, stripHelpOpen });
  }
  return {
    ...DEFAULT_SCORES_VIEWS,
    saveView: (rawName, settings) => {
      const name = cleanViewName(rawName);
      if (!name) return 'empty';
      const { views } = get();
      const at = views.findIndex((view) => sameName(view.name, name));
      if (at >= 0) {
        update({ views: views.map((view, i) => (i === at ? { name, settings } : view)) });
        return 'replaced';
      }
      if (views.length >= MAX_SAVED_VIEWS) return 'full';
      update({ views: [...views, { name, settings }] });
      return 'saved';
    },
    deleteView: (name) =>
      update({ views: get().views.filter((view) => !sameName(view.name, name)) }),
    setStripHelpOpen: (stripHelpOpen) => update({ stripHelpOpen }),
  };
});

/** Client-only, post-mount: applies the stored preferences. Never call during render or SSR. */
export function hydrateMomentumScoresViewsFromStorage(): void {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(MOMENTUM_SCORES_VIEWS_STORAGE_KEY);
  } catch {
    stored = null;
  }
  useMomentumScoresViewsStore.setState(parseStoredScoresViews(stored));
}
