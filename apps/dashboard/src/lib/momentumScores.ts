/**
 * Pure helpers for the Momentum › Scores page: filtering, sorting, sort-header state, score
 * bands and the Held / Candidate marks read off a weekly signal. No React, no formatting.
 */

export interface StockScore {
  symbol: string;
  company_name: string;
  parent_group: string;
  subgroup: string;
  last_price: number | null;
  change_1w_pct: number | null;
  returns: Record<string, number | null>;
  scores: Record<string, number | null>;
}

export interface SectorScore {
  cid: string;
  parent_group: string;
  subgroup: string;
  member_count: number;
  qualifying_count: number;
  scores: Record<string, number | null>;
}

export interface MomentumScores {
  as_of: string | null;
  universe_size: number;
  lookbacks: number[];
  missing_symbols: string[];
  stocks: StockScore[];
  sectors: SectorScore[];
}

// --- Sorting ---------------------------------------------------------------------------------

export type ScoreSortKey = 'name' | 'price' | 'change' | 'members' | 'score';

export interface ScoreSort {
  key: ScoreSortKey;
  /** Which lookback's score ranks the rows; only read when `key` is 'score'. */
  lookback: number | null;
  ascending: boolean;
}

export type AriaSort = 'ascending' | 'descending' | 'none';

function sameColumn(sort: ScoreSort, key: ScoreSortKey, lookback: number | null): boolean {
  return sort.key === key && (key !== 'score' || sort.lookback === lookback);
}

/**
 * The sort after clicking a header: the active column flips direction, any other column
 * becomes active with its natural first direction (A to Z for names, highest first for numbers).
 */
export function nextSort(
  sort: ScoreSort,
  key: ScoreSortKey,
  lookback: number | null = null,
): ScoreSort {
  if (sameColumn(sort, key, lookback)) return { ...sort, ascending: !sort.ascending };
  return { key, lookback: key === 'score' ? lookback : null, ascending: key === 'name' };
}

/** `aria-sort` for a header cell. */
export function ariaSort(
  sort: ScoreSort,
  key: ScoreSortKey,
  lookback: number | null = null,
): AriaSort {
  if (!sameColumn(sort, key, lookback)) return 'none';
  return sort.ascending ? 'ascending' : 'descending';
}

/** Missing values go last whichever way the column is sorted. */
function compareNumbers(
  a: number | null | undefined,
  b: number | null | undefined,
  ascending: boolean,
): number {
  const aMissing = a == null || !Number.isFinite(a);
  const bMissing = b == null || !Number.isFinite(b);
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  return ascending ? a - b : b - a;
}

function compareText(a: string, b: string, ascending: boolean): number {
  return ascending ? a.localeCompare(b) : b.localeCompare(a);
}

/** A sorted copy. A key that does not apply to stocks ('members') falls back to the score. */
export function sortStocks(stocks: readonly StockScore[], sort: ScoreSort): StockScore[] {
  const lookback = String(sort.lookback);
  return [...stocks].sort((a, b) => {
    if (sort.key === 'name') return compareText(a.symbol, b.symbol, sort.ascending);
    if (sort.key === 'price') return compareNumbers(a.last_price, b.last_price, sort.ascending);
    if (sort.key === 'change')
      return compareNumbers(a.change_1w_pct, b.change_1w_pct, sort.ascending);
    return compareNumbers(a.scores[lookback], b.scores[lookback], sort.ascending);
  });
}

/** A sorted copy. Keys that do not apply to sectors ('price', 'change') fall back to the score. */
export function sortSectors(sectors: readonly SectorScore[], sort: ScoreSort): SectorScore[] {
  const lookback = String(sort.lookback);
  return [...sectors].sort((a, b) => {
    if (sort.key === 'name') return compareText(a.subgroup, b.subgroup, sort.ascending);
    if (sort.key === 'members')
      return compareNumbers(a.qualifying_count, b.qualifying_count, sort.ascending);
    return compareNumbers(a.scores[lookback], b.scores[lookback], sort.ascending);
  });
}

// --- Filtering -------------------------------------------------------------------------------

/** The parent-group filter's "no filter" value. */
export const ALL_GROUPS = '';

export interface ScoreFilter {
  /** Free text, matched case-insensitively. */
  query: string;
  /** A `parent_group`, or `ALL_GROUPS`. */
  group: string;
}

export interface GroupOption {
  group: string;
  count: number;
}

/** Each parent group present in the rows with its row count, A to Z. */
export function parentGroups(rows: readonly { parent_group: string }[]): GroupOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.parent_group) continue;
    counts.set(row.parent_group, (counts.get(row.parent_group) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

function matches(haystack: string, filter: ScoreFilter, parentGroup: string): boolean {
  if (filter.group !== ALL_GROUPS && parentGroup !== filter.group) return false;
  const needle = filter.query.trim().toLowerCase();
  return !needle || haystack.toLowerCase().includes(needle);
}

/** Stocks in the chosen parent group whose symbol, company or sector contains the text. */
export function filterStocks(stocks: readonly StockScore[], filter: ScoreFilter): StockScore[] {
  return stocks.filter((stock) =>
    matches(`${stock.symbol} ${stock.company_name} ${stock.subgroup}`, filter, stock.parent_group),
  );
}

/** Sectors in the chosen parent group whose name or parent group contains the text. */
export function filterSectors(sectors: readonly SectorScore[], filter: ScoreFilter): SectorScore[] {
  return sectors.filter((sector) =>
    matches(`${sector.subgroup} ${sector.parent_group}`, filter, sector.parent_group),
  );
}

/** The stocks tagged to one sector row. */
export function sectorMembers(
  stocks: readonly StockScore[],
  sector: Pick<SectorScore, 'parent_group' | 'subgroup'>,
): StockScore[] {
  return stocks.filter(
    (stock) => stock.parent_group === sector.parent_group && stock.subgroup === sector.subgroup,
  );
}

// --- Score bands -----------------------------------------------------------------------------

export type ScoreBand = 'weak' | 'middle' | 'strong';

/** 0–40 weak, above 40 to 60 middle, above 60 strong; null when there is no score. */
export function scoreBand(value: number | null | undefined): ScoreBand | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= 40) return 'weak';
  if (value <= 60) return 'middle';
  return 'strong';
}

/** -1, 0 or 1 for a return; null when missing. Drives the positive / negative colouring. */
export function signOf(value: number | null | undefined): -1 | 0 | 1 | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

// --- Held / Candidate marks from a weekly signal ---------------------------------------------

export type SignalMark = 'held' | 'candidate';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Signal rows name an asset by symbol or display name; compare them case-insensitively. */
export function markKey(name: string): string {
  return name.trim().toUpperCase();
}

/**
 * Which assets a weekly signal holds or would buy, keyed by `markKey(asset)` (and by the row's
 * trade ETF when it has one).
 *
 * - Held: the row says `held` (the strategy owns it going into this signal, including a name
 *   the signal now sells).
 * - Candidate: not held, and either the signal's action is a buy or a wait-for-a-slot, or the
 *   row ranks inside the strategy's top N (`topN`, when the saved config has one).
 *
 * `rows` is taken as unknown because the signal payload is untyped; anything malformed is skipped.
 */
export function signalMarks(rows: unknown, topN: number | null = null): Map<string, SignalMark> {
  const marks = new Map<string, SignalMark>();
  if (!Array.isArray(rows)) return marks;
  for (const row of rows) {
    if (!isRecord(row) || typeof row.asset !== 'string' || !row.asset.trim()) continue;
    const action = typeof row.action === 'string' ? row.action.trim().toUpperCase() : '';
    const rank = typeof row.rank === 'number' && Number.isFinite(row.rank) ? row.rank : null;
    let mark: SignalMark | null = null;
    if (row.held === true) mark = 'held';
    else if (
      action.startsWith('BUY') ||
      action === 'WAIT' ||
      (topN !== null && rank !== null && rank <= topN)
    )
      mark = 'candidate';
    if (!mark) continue;
    marks.set(markKey(row.asset), mark);
    if (typeof row.etf === 'string' && row.etf.trim()) marks.set(markKey(row.etf), mark);
  }
  return marks;
}

export interface ActiveSignal {
  /** The strategy's name. */
  name: string;
  dataset: string | null;
  /** The Friday-labelled week the signal is for, when the payload says. */
  week: string | null;
  /** Why the strategy produced no signal, when it was blocked. */
  blocked: string | null;
  marks: Map<string, SignalMark>;
}

/**
 * The Telegram-active strategy's signal out of a weekly job (`/api/momentum/weekly/jobs/latest`).
 * Null when there is no finished job or no active strategy in it.
 */
export function activeSignalFromJob(payload: unknown): ActiveSignal | null {
  if (!isRecord(payload) || !isRecord(payload.job)) return null;
  const { job } = payload;
  if (job.status !== 'done' || !isRecord(job.result)) return null;
  const strategies = job.result.strategies;
  if (!Array.isArray(strategies)) return null;
  const active = strategies.find(
    (strategy): strategy is Record<string, unknown> =>
      isRecord(strategy) && strategy.active === true,
  );
  if (!active) return null;
  const signal = isRecord(active.signal) ? active.signal : null;
  const config = signal && isRecord(signal.config) ? signal.config : null;
  const topN =
    config && typeof config.top_n === 'number' && Number.isFinite(config.top_n)
      ? config.top_n
      : null;
  return {
    name: typeof active.name === 'string' ? active.name : 'Active strategy',
    dataset: typeof active.dataset === 'string' ? active.dataset : null,
    week: signal && typeof signal.week === 'string' ? signal.week : null,
    blocked: typeof active.blocked === 'string' ? active.blocked : null,
    marks: signalMarks(signal?.rows, topN),
  };
}
