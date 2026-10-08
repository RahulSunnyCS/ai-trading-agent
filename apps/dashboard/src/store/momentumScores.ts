import { create } from 'zustand';

/**
 * What the reader has chosen on Momentum › Scores, remembered in this browser: the optional
 * columns of the stock table switched off, and how many scored stocks a sector needs for a dot on
 * the rotation map. SSR-safe like `store/momentumView.ts`: fixed defaults on the server
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

/** The rotation map's default: a sector needs this many scored stocks to get a dot. */
export const DEFAULT_MIN_STOCKS = 5;
export const MIN_STOCK_CHOICES = [1, 3, 5, 10] as const;

function storedObject(stored: string | null): Record<string, unknown> {
  if (!stored) return {};
  try {
    const value: unknown = JSON.parse(stored);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Any stored value -> the set of hidden columns; unknown or malformed entries are dropped. */
export function parseHiddenColumns(stored: string | null): ReadonlySet<ScoreColumn> {
  const hidden = storedObject(stored).hidden;
  if (!Array.isArray(hidden)) return new Set();
  return new Set(
    hidden.filter((id): id is ScoreColumn => typeof id === 'string' && COLUMN_IDS.has(id)),
  );
}

/** Any stored value -> the minimum stocks per map dot; anything but a known choice is the default. */
export function parseMinStocks(stored: string | null): number {
  const value = storedObject(stored).minStocks;
  return (MIN_STOCK_CHOICES as readonly unknown[]).includes(value)
    ? (value as number)
    : DEFAULT_MIN_STOCKS;
}

interface MomentumScoresState {
  hidden: ReadonlySet<ScoreColumn>;
  /** Fewest scored stocks a sector needs for a dot on the rotation map. */
  minStocks: number;
  setColumnShown: (column: ScoreColumn, shown: boolean) => void;
  setMinStocks: (minStocks: number) => void;
}

function persist(hidden: ReadonlySet<ScoreColumn>, minStocks: number): void {
  try {
    window.localStorage.setItem(
      MOMENTUM_SCORES_STORAGE_KEY,
      JSON.stringify({ hidden: [...hidden], minStocks }),
    );
  } catch {
    // Storage full or blocked: the choice still applies for this visit.
  }
}

export const useMomentumScoresStore = create<MomentumScoresState>((set, get) => ({
  hidden: new Set(),
  minStocks: DEFAULT_MIN_STOCKS,
  setColumnShown: (column, shown) => {
    const hidden = new Set(get().hidden);
    if (shown) hidden.delete(column);
    else hidden.add(column);
    set({ hidden });
    persist(hidden, get().minStocks);
  },
  setMinStocks: (minStocks) => {
    set({ minStocks });
    persist(get().hidden, minStocks);
  },
}));

/** Client-only, post-mount: applies the stored choices. Never call during render or SSR. */
export function hydrateMomentumScoresFromStorage(): void {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(MOMENTUM_SCORES_STORAGE_KEY);
  } catch {
    stored = null;
  }
  useMomentumScoresStore.setState({
    hidden: parseHiddenColumns(stored),
    minStocks: parseMinStocks(stored),
  });
}
