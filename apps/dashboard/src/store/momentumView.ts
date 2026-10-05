import { create } from 'zustand';

/**
 * How the Momentum backtest result is laid out, remembered in this browser: whether the results
 * take the full width, which collapsible parts of the chart are open, and which details tab was
 * last open.
 *
 * SSR-safe in the same way as `store/settings.ts`: fixed defaults on the server and on the
 * client's first render; `hydrateMomentumViewFromStorage()` applies the stored values from an
 * effect after mount.
 */
export const DETAILS_TABS = ['returns', 'week', 'trades', 'split', 'risk', 'compare'] as const;
export type DetailsTab = (typeof DETAILS_TABS)[number];

export interface MomentumViewPrefs {
  /** Results across the whole width, settings column hidden (from the xl breakpoint). */
  resultsExpanded: boolean;
  /** The "Week changes" list above the plot. */
  weekChangesOpen: boolean;
  /** The drawdown and 52-week-edge sub-panels of the chart. */
  drawdownOpen: boolean;
  /** The open details tab; null = all collapsed. */
  detailsTab: DetailsTab | null;
}

export const MOMENTUM_VIEW_STORAGE_KEY = 'ata.momentumView.v1';

export const DEFAULT_MOMENTUM_VIEW: MomentumViewPrefs = {
  resultsExpanded: false,
  weekChangesOpen: false,
  drawdownOpen: false,
  detailsTab: null,
};

function isDetailsTab(value: unknown): value is DetailsTab {
  return typeof value === 'string' && (DETAILS_TABS as readonly string[]).includes(value);
}

/** Any stored value → valid preferences; each field falls back to its default on its own. */
export function normalizeMomentumView(value: unknown): MomentumViewPrefs {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    resultsExpanded: raw.resultsExpanded === true,
    weekChangesOpen: raw.weekChangesOpen === true,
    drawdownOpen: raw.drawdownOpen === true,
    detailsTab: isDetailsTab(raw.detailsTab) ? raw.detailsTab : null,
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
  setResultsExpanded: (expanded: boolean) => void;
  setWeekChangesOpen: (open: boolean) => void;
  setDrawdownOpen: (open: boolean) => void;
  setDetailsTab: (tab: DetailsTab | null) => void;
}

export const useMomentumViewStore = create<MomentumViewState>((set, get) => {
  function update(patch: Partial<MomentumViewPrefs>): void {
    set(patch);
    const state = get();
    persist({
      resultsExpanded: state.resultsExpanded,
      weekChangesOpen: state.weekChangesOpen,
      drawdownOpen: state.drawdownOpen,
      detailsTab: state.detailsTab,
    });
  }
  return {
    ...DEFAULT_MOMENTUM_VIEW,
    setResultsExpanded: (resultsExpanded) => update({ resultsExpanded }),
    setWeekChangesOpen: (weekChangesOpen) => update({ weekChangesOpen }),
    setDrawdownOpen: (drawdownOpen) => update({ drawdownOpen }),
    setDetailsTab: (detailsTab) => update({ detailsTab }),
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
