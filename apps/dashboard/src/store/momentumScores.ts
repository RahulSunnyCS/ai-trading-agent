import { create } from 'zustand';

/**
 * Which optional columns of the Momentum › Scores stock table the reader has switched off,
 * remembered in this browser. SSR-safe like `store/momentumView.ts`: fixed defaults on the server
 * and on the client's first render, `hydrateMomentumScoresFromStorage()` from an effect after.
 */
export const SCORE_COLUMNS = [
  { id: 'sector', label: 'Sector' },
  { id: 'trend', label: 'Trend' },
  { id: 'spark', label: '26 weeks' },
  { id: 'return13', label: '13w return' },
  { id: 'return26', label: '26w return' },
  { id: 'high', label: 'From 52w high' },
  { id: 'price', label: 'Last price' },
] as const;
export type ScoreColumn = (typeof SCORE_COLUMNS)[number]['id'];

export const MOMENTUM_SCORES_STORAGE_KEY = 'ata.momentumScores.v1';

const COLUMN_IDS: ReadonlySet<string> = new Set(SCORE_COLUMNS.map((column) => column.id));

/** Any stored value -> the set of hidden columns; unknown or malformed entries are dropped. */
export function parseHiddenColumns(stored: string | null): ReadonlySet<ScoreColumn> {
  if (!stored) return new Set();
  try {
    const value: unknown = JSON.parse(stored);
    const hidden =
      value && typeof value === 'object' ? (value as Record<string, unknown>).hidden : null;
    if (!Array.isArray(hidden)) return new Set();
    return new Set(
      hidden.filter((id): id is ScoreColumn => typeof id === 'string' && COLUMN_IDS.has(id)),
    );
  } catch {
    return new Set();
  }
}

interface MomentumScoresState {
  hidden: ReadonlySet<ScoreColumn>;
  setColumnShown: (column: ScoreColumn, shown: boolean) => void;
}

export const useMomentumScoresStore = create<MomentumScoresState>((set, get) => ({
  hidden: new Set(),
  setColumnShown: (column, shown) => {
    const hidden = new Set(get().hidden);
    if (shown) hidden.delete(column);
    else hidden.add(column);
    set({ hidden });
    try {
      window.localStorage.setItem(
        MOMENTUM_SCORES_STORAGE_KEY,
        JSON.stringify({ hidden: [...hidden] }),
      );
    } catch {
      // Storage full or blocked: the choice still applies for this visit.
    }
  },
}));

/** Client-only, post-mount: applies the stored choice. Never call during render or SSR. */
export function hydrateMomentumScoresFromStorage(): void {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(MOMENTUM_SCORES_STORAGE_KEY);
  } catch {
    stored = null;
  }
  useMomentumScoresStore.setState({ hidden: parseHiddenColumns(stored) });
}
