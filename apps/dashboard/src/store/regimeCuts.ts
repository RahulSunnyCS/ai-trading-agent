import { useEffect } from 'react';
import { create } from 'zustand';

import { DEFAULT_CUTS } from '../hooks/useLegwise';

/**
 * The session cut times (segment edges, e.g. 10:30 and 13:30) that split a trading day into
 * the segments Options Lab labels QUIET / CHOP / TREND. One store, so Market regimes, Daily
 * results and the day replay all slice the day the same way.
 *
 * Read with `useRegimeCuts()` in a component, or `getRegimeCuts()` outside React. Change with
 * `useRegimeCutsStore.getState().setCuts(...)` / `.resetCuts()`.
 *
 * SSR-safe like `store/theme.ts`: the store starts from `DEFAULT_CUTS` on the server and on
 * the client's first render; `hydrateRegimeCutsFromStorage()` applies the stored cuts after
 * mount (`useRegimeCuts()` calls it for you).
 */

/** Versioned key: `{ "cuts": ["10:30", "13:30"] }`. */
export const REGIME_CUTS_STORAGE_KEY = 'ata.regimeCuts.v1';
/** What the Market regimes tab wrote before this store existed: a bare JSON array. Read-only. */
export const LEGACY_REGIME_CUTS_KEY = 'optionslab.cuts';

export const MIN_CUTS = 1;
export const MAX_CUTS = 4;
const SESSION_OPEN = '09:15';
const SESSION_CLOSE = '15:30';

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

/** Client-side mirror of anatomy.parse_cuts: null when the cuts are usable, else why not. */
export function validateCuts(cuts: readonly string[]): string | null {
  if (cuts.length < MIN_CUTS || cuts.length > MAX_CUTS) {
    return `Use between ${MIN_CUTS} and ${MAX_CUTS} cut times.`;
  }
  if (cuts.some((c) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(c))) {
    return 'Cut times must look like 10:30.';
  }
  const minutes = cuts.map(minutesOf);
  if (minutes.some((m) => m <= minutesOf(SESSION_OPEN) || m >= minutesOf(SESSION_CLOSE))) {
    return 'Cuts must fall inside the session (09:16–15:29).';
  }
  if (minutes.some((m, i) => i > 0 && m <= (minutes[i - 1] ?? 0))) {
    return 'Cuts must be in increasing order.';
  }
  return null;
}

/**
 * Any value → usable cuts, or null. Accepts the versioned shape (`{ cuts: [...] }`) and the
 * legacy bare array; trims each entry and drops seconds ("10:30:00" → "10:30").
 */
export function normaliseCuts(value: unknown): string[] | null {
  const list =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as { cuts?: unknown }).cuts
      : value;
  if (!Array.isArray(list) || !list.every((c): c is string => typeof c === 'string')) return null;
  const cuts = list.map((c) => c.trim().replace(/^(\d{2}:\d{2}):\d{2}$/, '$1'));
  return validateCuts(cuts) === null ? cuts : null;
}

/** A raw localStorage string → usable cuts, or null when it is missing or malformed. */
export function parseStoredCuts(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    return normaliseCuts(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * The cuts to start from: the versioned key when it holds usable cuts, else the legacy key
 * (so cuts customised before this store existed are kept), else `DEFAULT_CUTS`.
 */
export function resolveStoredCuts(
  stored: string | null | undefined,
  legacy: string | null | undefined,
): string[] {
  return parseStoredCuts(stored) ?? parseStoredCuts(legacy) ?? [...DEFAULT_CUTS];
}

export function sameCuts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/** Whether the cuts are the built-in ones. */
export function isDefaultCuts(cuts: readonly string[]): boolean {
  return sameCuts(cuts, DEFAULT_CUTS);
}

/** Segment names for a set of cuts: ['09:15–10:30', '10:30–13:30', '13:30–15:30']. */
export function segmentNames(cuts: readonly string[]): string[] {
  const edges = [SESSION_OPEN, ...cuts, SESSION_CLOSE];
  return edges.slice(1).map((end, i) => `${edges[i]}–${end}`);
}

function readStorage(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null; // storage blocked: behave as if nothing is stored
  }
}

function persist(cuts: readonly string[]): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(REGIME_CUTS_STORAGE_KEY, JSON.stringify({ cuts }));
  } catch {
    // not persisted: the cuts still apply for this visit
  }
}

interface RegimeCutsState {
  cuts: readonly string[];
  /** False until the stored cuts have been applied (first client effect). */
  hydrated: boolean;
  /** Applies and persists the cuts. Returns false (and changes nothing) when they are invalid. */
  setCuts: (cuts: readonly string[]) => boolean;
  /** Back to `DEFAULT_CUTS`, persisted. */
  resetCuts: () => void;
}

export const useRegimeCutsStore = create<RegimeCutsState>((set, get) => ({
  cuts: DEFAULT_CUTS,
  hydrated: false,
  setCuts: (cuts) => {
    const next = normaliseCuts([...cuts]);
    if (next === null) return false;
    persist(next);
    // Keep the same array when nothing changed, so dependants do not refetch.
    set({ cuts: sameCuts(next, get().cuts) ? get().cuts : next, hydrated: true });
    return true;
  },
  resetCuts: () => {
    persist(DEFAULT_CUTS);
    set({ cuts: DEFAULT_CUTS, hydrated: true });
  },
}));

/**
 * Client-only, after mount: applies the stored cuts once. Safe to call from several
 * components; later calls do nothing. Never call it during render or SSR.
 */
export function hydrateRegimeCutsFromStorage(): void {
  if (typeof window === 'undefined') return;
  const state = useRegimeCutsStore.getState();
  if (state.hydrated) return;
  const cuts = resolveStoredCuts(
    readStorage(REGIME_CUTS_STORAGE_KEY),
    readStorage(LEGACY_REGIME_CUTS_KEY),
  );
  useRegimeCutsStore.setState({
    cuts: sameCuts(cuts, state.cuts) ? state.cuts : cuts,
    hydrated: true,
  });
}

/**
 * The shared cuts, for a component. The array is stable between changes, so it is safe as a
 * hook dependency or to pass straight to `useAnatomy` / `useDayForensics`. The first render
 * returns `DEFAULT_CUTS`; stored cuts arrive right after mount.
 */
export function useRegimeCuts(): readonly string[] {
  useEffect(() => {
    hydrateRegimeCutsFromStorage();
  }, []);
  return useRegimeCutsStore((state) => state.cuts);
}

/**
 * The shared cuts outside React (an event handler, a URL builder). Applies the stored cuts
 * first when running in the browser. Do not call it while rendering: use `useRegimeCuts()`.
 */
export function getRegimeCuts(): readonly string[] {
  hydrateRegimeCutsFromStorage();
  return useRegimeCutsStore.getState().cuts;
}
