import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Which book the Rotation page (Options Lab › Today) shows first (owner, 2026-10-30: Adaptive
 * Tuned is becoming the primary): `tuned` (the default), `core` (Adaptive Classic, the live
 * journal's list C) or `base` (the fixed base). The hero chart, the Books table's order, the
 * Daily log and calendar, and the order of today's baskets follow it. One setting for this
 * browser.
 *
 * SSR-safe like `store/rotationSlippage.ts`: the default on the server and on the client's first
 * render; `hydrateRotationBookFromStorage()` applies the stored choice after mount
 * (`useRotationBook()` calls it). Storage is a convenience: when it is blocked the selector still
 * works for the visit.
 */

export type RotationBookView = 'tuned' | 'core' | 'base';

export const ROTATION_BOOK_VIEWS: readonly RotationBookView[] = ['tuned', 'core', 'base'];

/** Versioned key: `{ "view": "tuned" }`. */
export const ROTATION_BOOK_STORAGE_KEY = 'ata.rotationBook.v1';

export const DEFAULT_ROTATION_BOOK: RotationBookView = 'tuned';

function isView(value: unknown): value is RotationBookView {
  return typeof value === 'string' && (ROTATION_BOOK_VIEWS as readonly string[]).includes(value);
}

/** A raw localStorage string → the stored view, or null when it is missing or malformed. */
export function parseStoredBook(raw: string | null | undefined): RotationBookView | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const view = (value as { view?: unknown }).view;
    return isView(view) ? view : null;
  } catch {
    return null;
  }
}

function persist(view: RotationBookView): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ROTATION_BOOK_STORAGE_KEY, JSON.stringify({ view }));
  } catch {
    // not persisted: the choice still applies for this visit
  }
}

interface RotationBookState {
  view: RotationBookView;
  /** False until the stored choice has been applied (first client effect). */
  hydrated: boolean;
  setView: (view: RotationBookView) => void;
}

export const useRotationBookStore = create<RotationBookState>((set) => ({
  view: DEFAULT_ROTATION_BOOK,
  hydrated: false,
  setView: (view) => {
    persist(view);
    set({ view, hydrated: true });
  },
}));

/** Client-only, after mount: applies the stored choice once; later calls do nothing. */
export function hydrateRotationBookFromStorage(): void {
  if (typeof window === 'undefined') return;
  if (useRotationBookStore.getState().hydrated) return;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(ROTATION_BOOK_STORAGE_KEY);
  } catch {
    raw = null; // storage blocked: behave as if nothing is stored
  }
  useRotationBookStore.setState({
    view: parseStoredBook(raw) ?? DEFAULT_ROTATION_BOOK,
    hydrated: true,
  });
}

/** The book the Rotation page shows first, and its setter. The first render is the default. */
export function useRotationBook(): [RotationBookView, (view: RotationBookView) => void] {
  useEffect(() => {
    hydrateRotationBookFromStorage();
  }, []);
  const view = useRotationBookStore((state) => state.view);
  const setView = useRotationBookStore((state) => state.setView);
  return [view, setView];
}
