import { create } from 'zustand';

import { type AlertMemory, markShown, pruneMemory } from '../lib/momentumAlerts';
import type { MomentumAlert } from '../types/momentum';

/**
 * Which alerts have popped up today, remembered in this browser (the "at most once a day per
 * alert" rule, `lib/momentumAlerts.ts`). Storage is a convenience, never required: when it is
 * blocked or empty the pop-ups still work, once per page load.
 *
 * SSR-safe like `store/momentumView.ts`: empty and not hydrated on the server and on the
 * client's first render; `hydrateMomentumAlertsFromStorage()` loads the stored memory from an
 * effect after mount. The pop-up waits for `hydrated`, otherwise every open alert would pop up
 * again on each page load before the memory was read.
 */
export const MOMENTUM_ALERTS_STORAGE_KEY = 'ata.momentumAlerts.v1';

/** The raw localStorage string → memory; anything that is not { id: 'YYYY-MM-DD' } is dropped. */
export function parseStoredAlertMemory(stored: string | null): AlertMemory {
  if (!stored) return {};
  try {
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function persist(memory: AlertMemory): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MOMENTUM_ALERTS_STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Storage full or blocked: the memory still applies for this visit.
  }
}

interface MomentumAlertsState {
  shown: AlertMemory;
  hydrated: boolean;
  /** Record that `id` popped up on `today`. */
  markShown: (id: string, today: string) => void;
  /** Forget alerts that are neither open nor shown today. */
  prune: (open: readonly MomentumAlert[], today: string) => void;
}

export const useMomentumAlertsStore = create<MomentumAlertsState>((set, get) => ({
  shown: {},
  hydrated: false,
  markShown: (id, today) => {
    const next = markShown(get().shown, id, today);
    if (next === get().shown) return;
    set({ shown: next });
    persist(next);
  },
  prune: (open, today) => {
    const next = pruneMemory(get().shown, open, today);
    if (next === get().shown) return;
    set({ shown: next });
    persist(next);
  },
}));

/** The memory of two tabs, merged: the later day wins for an alert both remember. */
export function mergeAlertMemory(a: AlertMemory, b: AlertMemory): AlertMemory {
  const merged: Record<string, string> = { ...a };
  for (const [id, day] of Object.entries(b)) {
    if (!merged[id] || day > merged[id]) merged[id] = day;
  }
  return merged;
}

let listening = false;

/** Another tab recorded a pop-up: take it over, so an alert pops up once a day across tabs. */
function listenForOtherTabs(): void {
  if (listening || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return;
  }
  listening = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== MOMENTUM_ALERTS_STORAGE_KEY) return;
    const other = parseStoredAlertMemory(event.newValue);
    useMomentumAlertsStore.setState((state) => ({ shown: mergeAlertMemory(state.shown, other) }));
  });
}

/** Client-only, post-mount: loads what was remembered. Never call during render or SSR. */
export function hydrateMomentumAlertsFromStorage(): void {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(MOMENTUM_ALERTS_STORAGE_KEY);
  } catch {
    stored = null;
  }
  useMomentumAlertsStore.setState({ shown: parseStoredAlertMemory(stored), hydrated: true });
  listenForOtherTabs();
}
