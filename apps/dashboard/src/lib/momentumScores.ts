/**
 * Pure helpers for the Momentum › Scores page: filtering, sorting, sort-header state, the 1–10
 * score deciles and the trend tag read off them, the market's movers, and the Held / Candidate
 * marks read off a weekly signal. No React, no formatting.
 */

export interface StockScore {
  symbol: string;
  company_name: string;
  /** The stock's own sector: its first tag that is not a theme. */
  parent_group: string;
  subgroup: string;
  /** Every group the stock is tagged to (a sector, and perhaps a theme basket). */
  tags?: Array<{ parent_group: string; subgroup: string }>;
  last_price: number | null;
  change_1w_pct: number | null;
  returns: Record<string, number | null>;
  /** Percentile 0–100 of the return against the other scored stocks, per lookback in weeks. */
  scores: Record<string, number | null>;
  /** Broad Momentum's rank-sum ranking (1 = strongest) this week and last; null without 52 weeks. */
  composite_rank?: number | null;
  composite_rank_prev?: number | null;
  /** Last close over the 52-week high, minus 1 (0 at the high). */
  high_52w_gap?: number | null;
  above_ma40?: number | null;
  volatility_52w?: number | null;
  up_weeks_26?: number | null;
  /** The last 26 weekly closes, rebased to 100. */
  spark?: number[];
}

/** One group's (or sub-sector's) mean percentile scores, week by week, oldest first. */
export interface RotationGroup {
  /** "Financials" for a parent group, "Financials :: PSU Banks" for a sub-sector. */
  key: string;
  parent_group: string;
  subgroup: string | null;
  /** A theme basket (its stocks also sit in real sectors): in the table, never on the map. */
  theme: boolean;
  member_count: number;
  /** Members with a 26-week score now. */
  scored_count: number;
  s4: Array<number | null>;
  s26: Array<number | null>;
}

export interface Rotation {
  weeks: string[];
  groups: RotationGroup[];
  subs: RotationGroup[];
}

/** One stock's history for the drawer (`/api/momentum/scores/stock/<symbol>`). */
export interface StockDetail {
  symbol: string;
  /** 53 weekly closes with the 40-week average (null until 40 weeks exist). */
  weeks: string[];
  closes: Array<number | null>;
  ma40: Array<number | null>;
  /** Percentile score per lookback (weeks, as a string) over `score_weeks`. */
  score_weeks: string[];
  scores: Record<string, Array<number | null>>;
  /** Composite rank over `rank_weeks`; null where the stock had none. */
  rank_weeks: string[];
  ranks: Array<number | null>;
}

/** How wide the market's momentum is (shares are fractions). */
export interface Breadth {
  above_ma40: { now: number | null; week_ago: number | null; month_ago: number | null };
  positive_13w: { now: number | null; week_ago: number | null };
  median_26w: number | null;
  top_decile_26w: number | null;
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
  /** Stocks with a composite rank. */
  ranked_count?: number;
  breadth?: Breadth | null;
  /** Each group's and sub-sector's mean 4 and 26-week score over recent weeks (the rotation map). */
  rotation?: Rotation | null;
  missing_symbols: string[];
  stocks: StockScore[];
  sectors: SectorScore[];
}

// --- Sorting ---------------------------------------------------------------------------------

export type ScoreSortKey =
  | 'name'
  | 'price'
  | 'change'
  | 'members'
  | 'score'
  | 'rank'
  | 'high'
  | 'return';

/** The keys that sort by one lookback's figure. */
const LOOKBACK_KEYS: ReadonlySet<ScoreSortKey> = new Set(['score', 'return']);

export interface ScoreSort {
  key: ScoreSortKey;
  /** Which lookback's score or return orders the rows; only read for those two keys. */
  lookback: number | null;
  ascending: boolean;
}

export type AriaSort = 'ascending' | 'descending' | 'none';

function sameColumn(sort: ScoreSort, key: ScoreSortKey, lookback: number | null): boolean {
  return sort.key === key && (!LOOKBACK_KEYS.has(key) || sort.lookback === lookback);
}

/**
 * The sort after clicking a header: the active column flips direction, any other column
 * becomes active with its natural first direction (A to Z for names, 1 first for the rank,
 * highest first for other numbers).
 */
export function nextSort(
  sort: ScoreSort,
  key: ScoreSortKey,
  lookback: number | null = null,
): ScoreSort {
  if (sameColumn(sort, key, lookback)) return { ...sort, ascending: !sort.ascending };
  return {
    key,
    lookback: LOOKBACK_KEYS.has(key) ? lookback : null,
    ascending: key === 'name' || key === 'rank',
  };
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
    if (sort.key === 'rank')
      return compareNumbers(a.composite_rank, b.composite_rank, sort.ascending);
    if (sort.key === 'high') return compareNumbers(a.high_52w_gap, b.high_52w_gap, sort.ascending);
    if (sort.key === 'return')
      return compareNumbers(a.returns[lookback], b.returns[lookback], sort.ascending);
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
    matches(
      `${stock.symbol} ${stock.company_name} ${stock.subgroup} ${(stock.tags ?? []).map((tag) => tag.subgroup).join(' ')}`,
      filter,
      stock.parent_group,
    ),
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
  const tagged = (stock: StockScore): boolean =>
    (stock.tags?.length
      ? stock.tags
      : [{ parent_group: stock.parent_group, subgroup: stock.subgroup }]
    ).some((tag) => tag.parent_group === sector.parent_group && tag.subgroup === sector.subgroup);
  return stocks.filter(tagged);
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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Signal rows name an asset by symbol or display name; compare them case-insensitively, and
 * ignoring a split segment's `#2`. */
export function markKey(name: string): string {
  // Broad names a stock after a split as "SYM#2": the same company as "SYM".
  return name.trim().toUpperCase().replace(/#\d+$/, '');
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
  const dataset = typeof active.dataset === 'string' ? active.dataset : null;
  // Broad's saved request keeps its own N (`broad_off_top_n`); `top_n` there is an unused default.
  const topN = finiteNumber(config?.[dataset === 'broad' ? 'broad_off_top_n' : 'top_n']);
  return {
    name: typeof active.name === 'string' ? active.name : 'Active strategy',
    dataset,
    week: signal && typeof signal.week === 'string' ? signal.week : null,
    blocked: typeof active.blocked === 'string' ? active.blocked : null,
    marks: signalMarks(signal?.rows, topN),
  };
}

// --- The 1–10 deciles and the trend tag ------------------------------------------------------

/**
 * A 0–100 percentile as a 1–10 decile: 10 is the top tenth of the scored stocks (score 90 and
 * up), 1 the bottom tenth. Null when there is no score.
 */
export function decileOf(score: number | null | undefined): number | null {
  if (score == null || !Number.isFinite(score)) return null;
  return Math.min(10, Math.max(1, Math.floor(score / 10) + 1));
}

/** A stock's decile at one lookback (weeks). */
export function stockDecile(stock: StockScore, weeks: number): number | null {
  return decileOf(stock.scores[String(weeks)]);
}

export type TrendTag = 'leader' | 'emerging' | 'fading' | 'laggard' | 'mixed';

export const TREND_LABEL: Record<TrendTag, string> = {
  leader: 'Leader',
  emerging: 'Emerging',
  fading: 'Fading',
  laggard: 'Laggard',
  mixed: 'Mixed',
};

/**
 * The shape of a stock's deciles over 4, 13 and 26 weeks, named:
 * - Leader: strong on every horizon (13w and 26w at 8+, 4w at 7+): an established trend.
 * - Emerging: the 4-week decile 8+ but the 26-week one 6 or less: a new trend, earlier and riskier.
 * - Fading: 26-week 7+ but 4-week 4 or less: a trend losing steam.
 * - Laggard: 13 and 26 weeks both 3 or less.
 * Anything else is Mixed. Null when one of the three scores is missing.
 */
export function trendOf(stock: StockScore): TrendTag | null {
  const d4 = stockDecile(stock, 4);
  const d13 = stockDecile(stock, 13);
  const d26 = stockDecile(stock, 26);
  if (d4 === null || d13 === null || d26 === null) return null;
  if (d13 >= 8 && d26 >= 8 && d4 >= 7) return 'leader';
  if (d4 >= 8 && d26 <= 6) return 'emerging';
  if (d26 >= 7 && d4 <= 4) return 'fading';
  if (d13 <= 3 && d26 <= 3) return 'laggard';
  return 'mixed';
}

// --- The strategy's zone, rank movement and what changed this week ---------------------------

/** Where a held name is bought and where it is sold, in composite rank. */
export interface BuyZone {
  /** Rank 1 to `topN` is what the strategy buys. */
  topN: number;
  /** A holding is sold once its rank passes `exitRank`. */
  exitRank: number;
  /** Whose numbers these are: the active favourite's, or Broad Momentum's own defaults. */
  source: 'favourite' | 'default';
}

/** Broad Momentum's own defaults when no active Broad favourite says otherwise. */
export const DEFAULT_BUY_ZONE: BuyZone = { topN: 10, exitRank: 20, source: 'default' };

/**
 * The buy zone from the Telegram-active favourite's saved request (`broad_off_top_n` and
 * `broad_off_exit_rank`), else Broad's defaults. A non-Broad favourite carries neither key.
 */
export function buyZoneFrom(favourite: { config: Record<string, unknown> } | undefined): BuyZone {
  const topN = finiteNumber(favourite?.config.broad_off_top_n);
  const exitRank = finiteNumber(favourite?.config.broad_off_exit_rank);
  if (topN === null || exitRank === null || topN < 1 || exitRank < topN) return DEFAULT_BUY_ZONE;
  return { topN, exitRank, source: 'favourite' };
}

/** Places climbed this week (positive) or lost (negative); null without a rank both weeks. */
export function rankChange(stock: StockScore): number | null {
  const now = stock.composite_rank;
  const before = stock.composite_rank_prev;
  return now == null || before == null ? null : before - now;
}

/** Climbers are only counted among stocks now ranked this high: a jump from 600th to 300th is
 * noise to a strategy that buys the top few. */
export const CLIMBER_POOL = 100;

export interface Movers {
  /** The biggest climbers by places gained, among those now inside `CLIMBER_POOL`. */
  climbers: StockScore[];
  /** Newly inside the exit-rank zone, strongest first. */
  entered: StockScore[];
  /** Newly outside it, by where they stood last week. */
  dropped: StockScore[];
}

/** This week's movers among the ranked stocks, `limit` each. */
export function computeMovers(stocks: readonly StockScore[], zone: BuyZone, limit = 5): Movers {
  const ranked = stocks.filter(
    (stock) => stock.composite_rank != null && stock.composite_rank_prev != null,
  );
  const rank = (stock: StockScore): number => stock.composite_rank ?? Number.POSITIVE_INFINITY;
  const before = (stock: StockScore): number =>
    stock.composite_rank_prev ?? Number.POSITIVE_INFINITY;
  return {
    climbers: [...ranked]
      .filter((stock) => (rankChange(stock) ?? 0) > 0 && rank(stock) <= CLIMBER_POOL)
      .sort((a, b) => (rankChange(b) ?? 0) - (rankChange(a) ?? 0) || rank(a) - rank(b))
      .slice(0, limit),
    entered: ranked
      .filter((stock) => rank(stock) <= zone.exitRank && before(stock) > zone.exitRank)
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, limit),
    dropped: ranked
      .filter((stock) => rank(stock) > zone.exitRank && before(stock) <= zone.exitRank)
      .sort((a, b) => before(a) - before(b))
      .slice(0, limit),
  };
}

// --- Quick views -----------------------------------------------------------------------------

export type StockView =
  | 'all'
  | 'leaders'
  | 'emerging'
  | 'fading'
  | 'near_high'
  | 'held'
  | 'candidates';

export const STOCK_VIEWS: ReadonlyArray<{ id: StockView; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'leaders', label: 'Leaders' },
  { id: 'emerging', label: 'Emerging' },
  { id: 'fading', label: 'Fading' },
  { id: 'near_high', label: 'Near 52-week high' },
  { id: 'held', label: 'Held' },
  { id: 'candidates', label: 'Candidates' },
];

/** "Near the 52-week high": within 5% of it. */
export const NEAR_HIGH_GAP = -0.05;

export function inView(
  stock: StockScore,
  view: StockView,
  marks: ReadonlyMap<string, SignalMark> | undefined,
): boolean {
  switch (view) {
    case 'all':
      return true;
    case 'leaders':
      return trendOf(stock) === 'leader';
    case 'emerging':
      return trendOf(stock) === 'emerging';
    case 'fading':
      return trendOf(stock) === 'fading';
    case 'near_high':
      return stock.high_52w_gap != null && stock.high_52w_gap >= NEAR_HIGH_GAP;
    case 'held':
      return marks?.get(markKey(stock.symbol)) === 'held';
    case 'candidates':
      return marks?.get(markKey(stock.symbol)) === 'candidate';
  }
}

/** How many stocks each quick view holds, for the chips. */
export function viewCounts(
  stocks: readonly StockScore[],
  marks: ReadonlyMap<string, SignalMark> | undefined,
): Record<StockView, number> {
  const counts = Object.fromEntries(STOCK_VIEWS.map((view) => [view.id, 0])) as Record<
    StockView,
    number
  >;
  for (const stock of stocks)
    for (const view of STOCK_VIEWS) if (inView(stock, view.id, marks)) counts[view.id] += 1;
  return counts;
}

/** Stocks that are Leaders (the market strip's count). */
export function leaderCount(stocks: readonly StockScore[]): number {
  return stocks.filter((stock) => trendOf(stock) === 'leader').length;
}

/**
 * The strongest sub-sector: highest mean 26-week score among those with at least `minStocks`
 * qualifying stocks (a sector of two stocks is one stock's mood).
 */
export function topSector(sectors: readonly SectorScore[], minStocks = 5): SectorScore | null {
  let best: SectorScore | null = null;
  for (const sector of sectors) {
    const score = sector.scores['26'];
    if (score == null || sector.qualifying_count < minStocks) continue;
    if (best === null || score > (best.scores['26'] ?? Number.NEGATIVE_INFINITY)) best = sector;
  }
  return best;
}

// --- Decile colours --------------------------------------------------------------------------

/**
 * One tinted cell per decile, weakest (red) to strongest (green) on the dashboard's loss and
 * gain tokens. Literal class names, so Tailwind compiles each (the class test fails on one that
 * emits no CSS).
 */
export const DECILE_CLASS: Record<number, string> = {
  1: 'bg-negative/55',
  2: 'bg-negative/40',
  3: 'bg-negative/25',
  4: 'bg-negative/15',
  5: 'bg-surface-2',
  6: 'bg-positive/15',
  7: 'bg-positive/25',
  8: 'bg-positive/35',
  9: 'bg-positive/45',
  10: 'bg-positive/55',
};

// --- Rotation: where each group is, and which way it is moving ------------------------------

export type Quadrant = 'leading' | 'improving' | 'weakening' | 'lagging';

export const QUADRANT_LABEL: Record<Quadrant, string> = {
  leading: 'Leading',
  improving: 'Improving',
  weakening: 'Weakening',
  lagging: 'Lagging',
};

/** Weeks the "change in the 4-week score" looks back over. */
export const MOMENTUM_STEP = 4;

/** The map's centre lines: a score of 50 is the middle of the universe, a change of 0 no move. */
export function quadrantOf(strength: number, direction: number): Quadrant {
  if (strength >= 50) return direction >= 0 ? 'leading' : 'weakening';
  return direction >= 0 ? 'improving' : 'lagging';
}

export interface RotationPoint {
  /** The 26-week score, 0 to 100. */
  x: number;
  /** The 4-week score now minus 4 weeks earlier, in points. */
  y: number;
}

/** The point for week index `u`, or null when either score it needs is missing. */
function pointAt(group: RotationGroup, u: number): RotationPoint | null {
  const x = group.s26[u];
  const now = group.s4[u];
  const before = group.s4[u - MOMENTUM_STEP];
  if (x == null || now == null || before == null) return null;
  return { x, y: now - before };
}

export interface RotationEntry {
  key: string;
  label: string;
  group: RotationGroup;
  /** Where it is now; null when it has too little history to place. */
  now: RotationPoint | null;
  /** The last `tail` weeks up to now, oldest first (gaps dropped). */
  tail: RotationPoint[];
  quadrant: Quadrant | null;
  /** The quadrant it was in four weeks ago. */
  before: Quadrant | null;
  changed: boolean;
}

/**
 * A group placed on the map: its position now, the tail of positions over the last `tail`
 * weeks, and the quadrant it is in now and was in four weeks ago.
 */
export function rotationEntry(group: RotationGroup, tail: number): RotationEntry {
  const last = group.s26.length - 1;
  const now = pointAt(group, last);
  const prev = pointAt(group, last - MOMENTUM_STEP);
  const points: RotationPoint[] = [];
  for (let u = Math.max(MOMENTUM_STEP, last - tail); u <= last; u += 1) {
    const point = pointAt(group, u);
    if (point) points.push(point);
  }
  const quadrant = now ? quadrantOf(now.x, now.y) : null;
  const before = prev ? quadrantOf(prev.x, prev.y) : null;
  return {
    key: group.key,
    label: group.subgroup ?? group.parent_group,
    group,
    now,
    tail: points,
    quadrant,
    before,
    changed: quadrant !== null && before !== null && quadrant !== before,
  };
}

/** A URL-safe name: "Metals & Mining" -> "metals-and-mining". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A stock's tags, or its own sector when the payload carries none. */
function tagsOf(stock: StockScore): Array<{ parent_group: string; subgroup: string }> {
  return stock.tags?.length
    ? stock.tags
    : [{ parent_group: stock.parent_group, subgroup: stock.subgroup }];
}

/** The stocks tagged to a parent group (each once, however many of its sub-sectors they are in). */
export function stocksInGroup(stocks: readonly StockScore[], parentGroup: string): StockScore[] {
  return stocks.filter((stock) => tagsOf(stock).some((tag) => tag.parent_group === parentGroup));
}

/** The stocks tagged to one sub-sector. */
export function stocksInSub(
  stocks: readonly StockScore[],
  parentGroup: string,
  subgroup: string,
): StockScore[] {
  return stocks.filter((stock) =>
    tagsOf(stock).some((tag) => tag.parent_group === parentGroup && tag.subgroup === subgroup),
  );
}

/** Mean percentile score of the stocks at one lookback; null when none has one. */
export function meanScore(stocks: readonly StockScore[], weeks: number): number | null {
  const values = stocks
    .map((stock) => stock.scores[String(weeks)])
    .filter((value): value is number => value != null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** The mean score per lookback, as a score record a strip can draw. */
export function meanScores(
  stocks: readonly StockScore[],
  lookbacks: readonly number[],
): Record<string, number | null> {
  return Object.fromEntries(lookbacks.map((weeks) => [String(weeks), meanScore(stocks, weeks)]));
}

/** Share of the stocks above their 40-week average; null when none has one. */
export function shareAboveAverage(stocks: readonly StockScore[]): number | null {
  const known = stocks.filter((stock) => stock.above_ma40 != null);
  return known.length
    ? known.filter((stock) => (stock.above_ma40 ?? 0) > 0).length / known.length
    : null;
}

/** The median 26-week return of the stocks that have one. */
export function medianReturn(stocks: readonly StockScore[], weeks = 26): number | null {
  const values = stocks
    .map((stock) => stock.returns[String(weeks)])
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2
    ? (values[mid] ?? null)
    : ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2;
}

/** Where a stock stands among those of its sector: "1 of 5" by composite rank. */
export function rankInGroup(
  stock: StockScore,
  peers: readonly StockScore[],
): { place: number; of: number } | null {
  if (stock.composite_rank == null) return null;
  const ranked = peers.filter((peer) => peer.composite_rank != null);
  const own = stock.composite_rank;
  return {
    place: ranked.filter((peer) => (peer.composite_rank ?? 0) < own).length + 1,
    of: ranked.length,
  };
}

// --- The rows behind the map and its table ---------------------------------------------------

/** Longest tail the map can draw, in weeks, and the choices it offers. */
export const TAIL_CHOICES = [4, 8, 13] as const;

export interface RotationRow {
  entry: RotationEntry;
  /** The stocks tagged to the group. */
  stocks: StockScore[];
  /** Their mean score at each lookback, for the strip. */
  strip: Record<string, number | null>;
  /** Share of them above their 40-week average. */
  above: number | null;
  /** Gets a dot on the map; false rows are in the table only. */
  onMap: boolean;
  /** Why a row has no dot, when it does not. */
  why: string | null;
}

export interface RotationRowOptions {
  tail: number;
  /** Fewest scored stocks for a dot. */
  minStocks: number;
  /** Free text over the group's name. */
  query: string;
  /** Only the groups that crossed into another quadrant in the last 4 weeks. */
  changedOnly: boolean;
  lookbacks: readonly number[];
}

/**
 * The rows for a set of groups (parent groups, or the sub-sectors of one): each placed on the
 * map, with its stocks and strip for the table. Theme baskets, groups with too few scored stocks
 * and groups with too little history are table-only, said so in `why`. `changedOnly` keeps just
 * the groups that moved quadrant. Strongest 26-week score first, table-only rows last.
 */
export function buildRotationRows(
  groups: readonly RotationGroup[],
  stocksOf: (group: RotationGroup) => StockScore[],
  options: RotationRowOptions,
): RotationRow[] {
  const needle = options.query.trim().toLowerCase();
  const rows: RotationRow[] = [];
  for (const group of groups) {
    const entry = rotationEntry(group, options.tail);
    if (needle && !entry.label.toLowerCase().includes(needle)) continue;
    let why: string | null = null;
    if (group.theme) why = 'a theme basket, not a sector';
    else if (entry.now === null) why = 'too little history';
    else if (group.scored_count < options.minStocks)
      why = `fewer than ${options.minStocks} scored stocks`;
    if (options.changedOnly && (why !== null || !entry.changed)) continue;
    const stocks = stocksOf(group);
    rows.push({
      entry,
      stocks,
      strip: meanScores(stocks, options.lookbacks),
      above: shareAboveAverage(stocks),
      onMap: why === null,
      why,
    });
  }
  return rows.sort(
    (a, b) =>
      Number(b.onMap) - Number(a.onMap) ||
      (b.entry.group.s26.at(-1) ?? Number.NEGATIVE_INFINITY) -
        (a.entry.group.s26.at(-1) ?? Number.NEGATIVE_INFINITY),
  );
}

/** The sector group a URL slug names, among the parent groups. */
export function groupBySlug(
  groups: readonly RotationGroup[],
  slug: string | null,
): RotationGroup | null {
  return slug ? (groups.find((group) => slugify(group.parent_group) === slug) ?? null) : null;
}

/** The sub-sector a `?sub=` slug names, within one parent group. */
export function subBySlug(
  subs: readonly RotationGroup[],
  parentGroup: string,
  slug: string | null,
): RotationGroup | null {
  return slug
    ? (subs.find(
        (sub) => sub.parent_group === parentGroup && slugify(sub.subgroup ?? '') === slug,
      ) ?? null)
    : null;
}

/** Where a group's 26-week score stands among the sector groups (theme baskets left out). */
export function strengthRank(
  group: RotationGroup,
  groups: readonly RotationGroup[],
): { place: number; of: number } | null {
  const score = group.s26.at(-1);
  if (score == null) return null;
  const peers = groups.filter((g) => !g.theme && g.s26.at(-1) != null);
  return { place: peers.filter((g) => (g.s26.at(-1) ?? 0) > score).length + 1, of: peers.length };
}
