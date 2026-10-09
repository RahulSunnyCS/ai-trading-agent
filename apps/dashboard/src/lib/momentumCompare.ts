/**
 * Pure logic behind Momentum › Saved runs and the shared Compare panel: sorting with the
 * Telegram-active run pinned, the up-to-four selection, the best value per metric, the
 * "settings that differ" diff over the union of keys, the labels both use, and the small
 * series helpers (sparkline path, drawdown) the stored equity line needs.
 *
 * Kept out of the components so it can be unit-tested and so the Saved runs table and the
 * result's Compare tab can never disagree about a label, a winner or a difference.
 */

import { EMPTY, formatDay, formatNumber, formatPct, formatPp } from './format';

/** The part of a saved run this module reads; `MomentumSavedRun` satisfies it. */
export interface ComparableRun {
  id: string;
  name: string;
  n: number;
  created_at: string;
  active: boolean;
  config: Record<string, unknown>;
  kpis: Record<string, number | null | undefined>;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export type MetricKey =
  | 'cagr'
  | 'excess_cagr'
  | 'max_drawdown'
  | 'sharpe'
  | 'turnover_per_year'
  | 'avg_holdings';

export interface MetricDef {
  key: MetricKey;
  label: string;
  /** Column heading where space is tight. */
  short: string;
  format: (value: number | null | undefined) => string;
  /**
   * Which end wins: 'high' = the largest value (drawdown is stored negative, so the largest is
   * the shallowest), 'low' = the smallest, 'none' = neither end is better (holdings count).
   */
  better: 'high' | 'low' | 'none';
}

export const COMPARE_METRICS: MetricDef[] = [
  { key: 'cagr', label: 'CAGR', short: 'CAGR', format: (v) => formatPct(v), better: 'high' },
  {
    key: 'excess_cagr',
    label: 'Edge vs benchmark',
    short: 'Edge',
    format: (v) => formatPp(v),
    better: 'high',
  },
  {
    key: 'max_drawdown',
    label: 'Max drawdown',
    short: 'Max DD',
    format: (v) => formatPct(v),
    better: 'high',
  },
  {
    key: 'sharpe',
    label: 'Sharpe',
    short: 'Sharpe',
    format: (v) => formatNumber(v, 2),
    better: 'high',
  },
  {
    key: 'turnover_per_year',
    label: 'Turnover / year',
    short: 'Turnover',
    format: (v) => formatPct(v, 0),
    better: 'low',
  },
  {
    key: 'avg_holdings',
    label: 'Avg holdings',
    short: 'Avg held',
    format: (v) => formatNumber(v, 1),
    better: 'none',
  },
];

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Index of the run with the best value for a metric, or null when there is nothing to mark:
 * the metric has no better end, fewer than two runs carry it, or every run ties.
 */
export function bestRunIndex(runs: ComparableRun[], metric: MetricDef): number | null {
  if (metric.better === 'none') return null;
  let best: { index: number; value: number } | null = null;
  let seen = 0;
  let allEqual = true;
  let first: number | null = null;
  runs.forEach((run, index) => {
    const value = run.kpis[metric.key];
    if (!finite(value)) return;
    seen += 1;
    if (first === null) first = value;
    else if (value !== first) allEqual = false;
    const wins =
      best === null || (metric.better === 'high' ? value > best.value : value < best.value);
    if (wins) best = { index, value };
  });
  if (seen < 2 || allEqual) return null;
  return (best as { index: number; value: number } | null)?.index ?? null;
}

// ---------------------------------------------------------------------------
// Sorting (active run pinned)
// ---------------------------------------------------------------------------

export type SavedRunSortKey = 'name' | 'saved' | 'period' | MetricKey;
export type SortDirection = 'asc' | 'desc';

/** The direction a first click on a column sorts in: best (or newest) first. */
export function defaultSortDirection(key: SavedRunSortKey): SortDirection {
  return key === 'name' || key === 'period' || key === 'turnover_per_year' ? 'asc' : 'desc';
}

function sortValue(run: ComparableRun, key: SavedRunSortKey): number | string | null {
  if (key === 'name') return run.name.toLowerCase();
  if (key === 'saved') {
    const time = new Date(run.created_at).getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (key === 'period') return typeof run.config.start === 'string' ? run.config.start : null;
  const value = run.kpis[key];
  return finite(value) ? value : null;
}

/**
 * Saved runs in display order. The Telegram-active run always comes first, whatever the sort;
 * the rest follow by `key`. A run without the value sinks to the bottom in either direction.
 * The sort is stable, so ties keep the order they arrived in.
 */
export function sortSavedRuns<T extends ComparableRun>(
  runs: T[],
  key: SavedRunSortKey = 'saved',
  direction: SortDirection = defaultSortDirection(key),
): T[] {
  const sign = direction === 'desc' ? -1 : 1;
  return [...runs].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    return x < y ? -sign : x > y ? sign : 0;
  });
}

// ---------------------------------------------------------------------------
// Selection (up to four)
// ---------------------------------------------------------------------------

export const MAX_COMPARE = 4;

/** Tick or untick a run for comparison. A tick beyond `max` is refused and changes nothing. */
export function toggleSelection(
  selected: string[],
  id: string,
  max: number = MAX_COMPARE,
): { selected: string[]; refused: boolean } {
  if (selected.includes(id)) {
    return { selected: selected.filter((item) => item !== id), refused: false };
  }
  if (selected.length >= max) return { selected, refused: true };
  return { selected: [...selected, id], refused: false };
}

// ---------------------------------------------------------------------------
// Period / benchmark
// ---------------------------------------------------------------------------

/** "06 Jan 2017 → latest". `start`/`end` are plain calendar days in the saved config. */
export function runPeriod(config: Record<string, unknown>): string {
  const start = typeof config.start === 'string' && config.start ? formatDay(config.start) : EMPTY;
  const end = typeof config.end === 'string' && config.end ? formatDay(config.end) : 'latest';
  return `${start} → ${end}`;
}

export function runBenchmark(config: Record<string, unknown>): string {
  return typeof config.benchmark === 'string' && config.benchmark ? config.benchmark : EMPTY;
}

// ---------------------------------------------------------------------------
// Settings: labels, values, diff
// ---------------------------------------------------------------------------

/**
 * Every key that appears in a saved Momentum config, in the words the settings panel uses for
 * the same control. A key missing here falls back to a humanised form of itself.
 */
export const SETTING_LABELS: Record<string, string> = {
  dataset: 'Strategy',
  universe: 'Universe',
  start: 'From',
  end: 'To',
  benchmark: 'Benchmark',
  // Ranking rule
  lookbacks: 'Lookback weeks',
  weights: 'Lookback weights',
  score: 'Ranking rule',
  voladj_skip_recent_month: 'Skip the most recent month',
  reversal_tilt: 'Reversal tilt',
  reversal_screen_pct: 'Reversal screen: top % by short-term momentum',
  broad_reversal_tilt: 'Reversal tilt (stocks in category)',
  broad_reversal_screen_pct: 'Reversal screen (stocks in category): top % by short-term momentum',
  // Portfolio rule
  portfolio: 'Portfolio rule',
  entry: 'When full',
  top_n: 'Top N',
  exit_rank: 'Sell when rank >',
  rebalance: 'Rebalance',
  rebalance_every: 'Weeks between rebalances',
  rebalance_offset: 'Which Fridays (phase)',
  split_fridays: 'Fridays: one or all (split)',
  sell_every_week: 'Sell exits weekly, buy only on the cadence',
  momentum_sizing: 'Win-rate position sizing',
  momentum_sizing_window: 'Sizing window (trades)',
  momentum_sizing_floor: 'Min size floor',
  min_ranked: 'Minimum ranked names',
  // Position limits
  max_position: 'Max per holding',
  max_category: 'Max per category',
  cap_band: 'Trim when above by',
  max_stock_price: 'Max price to buy ₹',
  exclude_high_vol: 'Skip most volatile % (new buys)',
  // Inner rotation
  inner_top_n: 'Stocks per category',
  inner_exit_rank: 'Sell from category when rank >',
  commodity_copies: 'Gold/Silver slots',
  debt_copies: 'Cash/Gilt slots',
  // Crash protection
  defensive: 'Crash protection',
  filter_lookback: 'Must beat cash over (weeks)',
  // Costs, timing & tax
  cost_model: 'Cost model',
  capital: 'Capital ₹',
  slippage_bps: 'Slippage (bps)',
  cost_pct: 'Cost per side %',
  signal_delay: 'Trade (weeks after the signal)',
  track: 'P&L on',
  execution: 'Fill at',
  tax: 'Apply capital-gains tax',
  slab_rate: 'Tax slab',
  // Broad Momentum universe
  broad_universe: 'Broad universe',
  broad_category_mode: 'Rank categories',
  broad_pool_top_n: 'Pool top N',
  broad_pool_exit_rank: 'Pool exit rank',
  broad_every_week: 'Simulate every week',
  broad_coverage_floor: 'Coverage floor',
  broad_category_top_n: 'Categories held',
  broad_category_exit_rank: 'Sell category when rank >',
  broad_picks_per_category: 'Top stocks per category',
  broad_off_top_n: 'Stocks to hold',
  broad_off_exit_rank: 'Sell when rank > (stocks ranked directly)',
  broad_liquidity_filter: 'Tradability filter',
  broad_respect_circuits: 'Respect circuit locks (realistic fills)',
  broad_liq_min_turnover_cr: 'Minimum daily turnover (₹ crore)',
  broad_liq_floor_ratio: 'Worst-day floor (share of minimum)',
  broad_liq_min_price: 'Minimum price (₹)',
  broad_liq_circuit: 'Skip stocks stuck at circuit limits',
  broad_liq_circuit_run: 'Stuck-at-circuit run (sessions)',
  broad_liq_max_circuit_days: 'Circuit days allowed (last 60 sessions)',
  broad_category_tags: 'Category tags',
  broad_series_breaks: 'Series breaks',
};

/** Saved as a fraction, shown as a percentage. */
const FRACTION_KEYS = new Set([
  'max_position',
  'max_category',
  'cap_band',
  'slab_rate',
  'broad_coverage_floor',
  'momentum_sizing_floor',
  'broad_liq_floor_ratio',
]);

/** Coded choices, spelled the way the settings panel spells them. */
const CHOICE_LABELS: Record<string, Record<string, string>> = {
  dataset: {
    etf: 'ETF Rotation',
    stock: 'Nifty 50 Stocks',
    custom_index: 'Custom Index',
    broad: 'Broad Momentum',
  },
  score: { ranksum: 'Rank-sum', voladj: 'Volatility-adjusted', blend: 'Blend' },
  portfolio: { buffer: 'Buffer', slots: 'Fixed slots' },
  entry: { wait: 'Wait', make_room: 'Make room' },
  rebalance: { weekly: 'Weekly', monthly: 'Monthly' },
  defensive: { off: 'Off', ranked: 'Debt in ranking', filter: 'Cash filter' },
  cost_model: { flat: 'Flat %', itemised: 'Itemised' },
  track: { index: 'The index (underlying)', etf: "The ETF you'd trade" },
  execution: { fri_close: 'Friday close', mon_open: 'Monday open', mon_10am: 'Monday 10:00' },
  broad_universe: {
    total_market: 'Nifty Total Market',
    all_liquid: 'Whole NSE market (liquid only)',
  },
  broad_category_mode: { on: 'On', off: 'Off (rank stocks directly)' },
};

export function settingLabel(key: string): string {
  const known = SETTING_LABELS[key];
  if (known) return known;
  const words = key.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function plainNumber(value: number): string {
  return formatNumber(value, 4, { trim: true });
}

/** A config value as text. `key` picks the unit and the wording of coded choices. */
export function formatSettingValue(value: unknown, key = ''): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return EMPTY;
    if (key === 'rebalance_offset') return `Phase ${plainNumber(value + 1)}`;
    return FRACTION_KEYS.has(key)
      ? formatPct(value, 2).replace(/\.?0+%$/, '%')
      : plainNumber(value);
  }
  if (typeof value === 'string') {
    if (key === 'start' || key === 'end') return formatDay(value);
    return CHOICE_LABELS[key]?.[value] ?? value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return EMPTY;
    return value.map((item) => formatSettingValue(item)).join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([name, item]) => `${name}: ${formatSettingValue(item)}`)
      .join(', ');
  }
  return String(value);
}

/** Order-stable JSON, so `{a, b}` and `{b, a}` compare equal; a missing key equals null. */
function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonical(record[name])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface SettingDifference {
  key: string;
  label: string;
  /** One display value per config, in the order the configs were given. */
  values: string[];
}

/**
 * The settings on which the given configs disagree, over the UNION of their keys: a key only
 * one run carries still shows up (as "—" for the others). Keys come out in settings-panel
 * order (the order of SETTING_LABELS), unknown keys after them alphabetically.
 */
export function differingSettings(configs: Array<Record<string, unknown>>): SettingDifference[] {
  if (configs.length < 2) return [];
  const keys = new Set<string>();
  for (const config of configs) for (const key of Object.keys(config)) keys.add(key);
  const order = Object.keys(SETTING_LABELS);
  const rank = (key: string): number => {
    const index = order.indexOf(key);
    return index < 0 ? order.length : index;
  };
  return [...keys]
    .filter((key) => new Set(configs.map((config) => canonical(config[key]))).size > 1)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((key) => ({
      key,
      label: settingLabel(key),
      values: configs.map((config) => formatSettingValue(config[key], key)),
    }));
}

/** Every setting of one config as label/value pairs, in settings-panel order. */
export function listSettings(config: Record<string, unknown>): Array<{
  key: string;
  label: string;
  value: string;
}> {
  const order = Object.keys(SETTING_LABELS);
  const rank = (key: string): number => {
    const index = order.indexOf(key);
    return index < 0 ? order.length : index;
  };
  return Object.keys(config)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((key) => ({ key, label: settingLabel(key), value: formatSettingValue(config[key], key) }));
}

/**
 * A saved config with every setting it does not carry filled from `defaults`, so that a caller
 * which MERGES a loaded config over its current form ends up with exactly the saved run's
 * settings (a replace) instead of keeping stale values for the keys the run never stored.
 */
export function completeConfig(
  defaults: Record<string, unknown>,
  config: Record<string, unknown>,
): Record<string, unknown> {
  return { ...defaults, ...config };
}

// ---------------------------------------------------------------------------
// Series helpers
// ---------------------------------------------------------------------------

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * An SVG path ("M0,20 L3.4,18.2 …") for a sparkline of `values` in a `width` × `height` box,
 * thinned to at most `maxPoints` points. Null when fewer than two usable points exist.
 */
export function sparklinePath(
  values: Array<number | null | undefined>,
  width: number,
  height: number,
  maxPoints = 60,
): string | null {
  const usable = values.filter(finite);
  if (usable.length < 2) return null;
  const step = Math.max(1, Math.ceil(usable.length / maxPoints));
  const points: number[] = [];
  for (let i = 0; i < usable.length; i += step) points.push(usable[i] as number);
  const last = usable[usable.length - 1] as number;
  if ((usable.length - 1) % step !== 0) points.push(last);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;
  const pad = 1;
  return points
    .map((value, index) => {
      const x = round1((index / (points.length - 1)) * width);
      const y =
        span === 0
          ? round1(height / 2)
          : round1(pad + (1 - (value - min) / span) * (height - 2 * pad));
      return `${index === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

/** The first and last usable values of a series, or null when it has fewer than two. */
export function seriesEnds(
  values: Array<number | null | undefined>,
): { first: number; last: number } | null {
  const usable = values.filter(finite);
  if (usable.length < 2) return null;
  return { first: usable[0] as number, last: usable[usable.length - 1] as number };
}

/** Fall from the running peak at each point, as a fraction (0 at a high, -0.25 a quarter down). */
export function drawdownSeries(values: Array<number | null>): Array<number | null> {
  let peak = Number.NEGATIVE_INFINITY;
  return values.map((value) => {
    if (!finite(value)) return null;
    peak = Math.max(peak, value);
    return peak > 0 ? value / peak - 1 : null;
  });
}
