import { useEffect } from 'react';
import { create } from 'zustand';

import { withSlippage } from '../lib/rotationSlippage';

/**
 * The Rotation pages' slippage switch (`lib/rotationSlippage.ts`), one setting for this browser:
 * Options Lab › Rotation, Matrix and Correlation, and the Overview's rotation card all follow it.
 * On by default.
 *
 * SSR-safe like `store/regimeCuts.ts`: the store starts from the default (on) on the server and
 * on the client's first render; `hydrateRotationSlippageFromStorage()` applies the stored choice
 * after mount (`useRotationSlippage()` calls it for you). Storage is a convenience: when it is
 * blocked the switch still works for the visit.
 */

/** Versioned key: `{ "on": true }`. */
export const ROTATION_SLIPPAGE_STORAGE_KEY = 'ata.rotationSlippage.v1';

export const DEFAULT_ROTATION_SLIPPAGE = true;

/** A raw localStorage string → the stored choice, or null when it is missing or malformed. */
export function parseStoredSlippage(raw: string | null | undefined): boolean | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const on = (value as { on?: unknown }).on;
    return typeof on === 'boolean' ? on : null;
  } catch {
    return null;
  }
}

function persist(on: boolean): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ROTATION_SLIPPAGE_STORAGE_KEY, JSON.stringify({ on }));
  } catch {
    // not persisted: the choice still applies for this visit
  }
}

interface RotationSlippageState {
  on: boolean;
  /** False until the stored choice has been applied (first client effect). */
  hydrated: boolean;
  setOn: (on: boolean) => void;
}

export const useRotationSlippageStore = create<RotationSlippageState>((set) => ({
  on: DEFAULT_ROTATION_SLIPPAGE,
  hydrated: false,
  setOn: (on) => {
    persist(on);
    set({ on, hydrated: true });
  },
}));

/** Client-only, after mount: applies the stored choice once; later calls do nothing. */
export function hydrateRotationSlippageFromStorage(): void {
  if (typeof window === 'undefined') return;
  if (useRotationSlippageStore.getState().hydrated) return;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(ROTATION_SLIPPAGE_STORAGE_KEY);
  } catch {
    raw = null; // storage blocked: behave as if nothing is stored
  }
  useRotationSlippageStore.setState({
    on: parseStoredSlippage(raw) ?? DEFAULT_ROTATION_SLIPPAGE,
    hydrated: true,
  });
}

/** Whether the Rotation pages show figures after slippage. The first render is the default. */
export function useRotationSlippage(): boolean {
  useEffect(() => {
    hydrateRotationSlippageFromStorage();
  }, []);
  return useRotationSlippageStore((state) => state.on);
}

/** `url` with the slippage parameter when the switch is on: a data hook's one-liner. */
export function useSlippageUrl(url: string): string {
  return withSlippage(url, useRotationSlippage());
}
