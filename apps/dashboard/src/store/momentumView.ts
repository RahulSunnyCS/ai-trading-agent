import { create } from 'zustand';

import { DEFAULT_BENCHMARK } from '../lib/momentumBenchmark';

/**
 * How the Momentum backtest result is laid out, remembered in this browser: the benchmark the
 * headline picker compares against, whether the chart's drawdown pane and its "Week changes"
 * list are open, and whether the headline's full metric set is showing.
 *
 * SSR-safe in the same way as `store/settings.ts`: fixed defaults on the server and on the
 * client's first render; `hydrateMomentumViewFromStorage()` applies the stored values from an
 * effect after mount. Keys stored by the earlier layout (full-width results, the advanced
 * tooltip toggle, the open details tab) are ignored.
 */
export interface MomentumViewPrefs {
  /** The picker's index (`result.benchmarks[].name`). */
  benchmark: string;
  /** The "Week changes" list under the plot. */
  weekChangesOpen: boolean;
  /** The drawdown and 52-week-edge panes under the equity curve. */
  drawdownOpen: boolean;
  /** Every metric under the headline numbers, not just the one-line summary. */
  metricsOpen: boolean;
}

export const MOMENTUM_VIEW_STORAGE_KEY = 'ata.momentumView.v1';

export const DEFAULT_MOMENTUM_VIEW: MomentumViewPrefs = {
  benchmark: DEFAULT_BENCHMARK,
  weekChangesOpen: false,
  drawdownOpen: false,
  metricsOpen: false,
};

/** Any stored value → valid preferences; each field falls back to its default on its own. */
export function normalizeMomentumView(value: unknown): MomentumViewPrefs {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    benchmark:
      typeof raw.benchmark === 'string' && raw.benchmark.trim() !== ''
        ? raw.benchmark
        : DEFAULT_BENCHMARK,
    weekChangesOpen: raw.weekChangesOpen === true,
    drawdownOpen: raw.drawdownOpen === true,
    metricsOpen: raw.metricsOpen === true,
  };
}

/** The raw localStorage string → preferences; nothing stored or bad JSON gives the defaults. */
export function parseStoredMomentumView(stored: string | null): MomentumViewPrefs {
  if (!stored) return DEFAULT_MOMENTUM_VIEW;
  try {
    return normalizeMomentumView(JSON.parse(stored));
  } catch {
    return DEFAULT_MOMENTUM_VIEW;
  }
}

function persist(prefs: MomentumViewPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MOMENTUM_VIEW_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: the preference still applies for this visit.
  }
}

interface MomentumViewState extends MomentumViewPrefs {
  setBenchmark: (name: string) => void;
  setWeekChangesOpen: (open: boolean) => void;
  setDrawdownOpen: (open: boolean) => void;
  setMetricsOpen: (open: boolean) => void;
}

export const useMomentumViewStore = create<MomentumViewState>((set, get) => {
  function update(patch: Partial<MomentumViewPrefs>): void {
    set(patch);
    const state = get();
    persist({
      benchmark: state.benchmark,
      weekChangesOpen: state.weekChangesOpen,
      drawdownOpen: state.drawdownOpen,
      metricsOpen: state.metricsOpen,
    });
  }
  return {
    ...DEFAULT_MOMENTUM_VIEW,
    setBenchmark: (benchmark) => update({ benchmark }),
    setWeekChangesOpen: (weekChangesOpen) => update({ weekChangesOpen }),
    setDrawdownOpen: (drawdownOpen) => update({ drawdownOpen }),
    setMetricsOpen: (metricsOpen) => update({ metricsOpen }),
  };
});

/** Client-only, post-mount: applies the stored preferences. Never call during render or SSR. */
export function hydrateMomentumViewFromStorage(): void {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(MOMENTUM_VIEW_STORAGE_KEY);
  } catch {
    stored = null;
  }
  useMomentumViewStore.setState(parseStoredMomentumView(stored));
}
