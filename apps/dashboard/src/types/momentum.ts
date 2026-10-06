export interface MomentumSeries {
  dates: string[];
  strategy: Array<number | null>;
  benchmark: Array<number | null>;
  cash: Array<number | null>;
  drawdown_strategy: Array<number | null>;
  drawdown_benchmark: Array<number | null>;
  rolling_52w_excess: Array<number | null>;
  idle_share: Array<number | null>;
  holdings_count: Array<number | null>;
}

export interface MomentumRotationOut {
  asset: string;
  rank: number | null;
  reason: string;
  weeks_held: number | null;
  return: number | null;
}

export interface MomentumRotationIn {
  asset: string;
  rank: number | null;
  top_up: boolean;
}

export interface MomentumRotationTrim {
  asset: string;
  reason: string;
}

export interface MomentumRotationHolding {
  asset: string;
  share: number;
}

export interface MomentumRotation {
  week: string;
  value: number;
  outs: MomentumRotationOut[];
  ins: MomentumRotationIn[];
  trims: MomentumRotationTrim[];
  parked: boolean;
  holdings: MomentumRotationHolding[];
}

/** A dividend-inclusive reference line (Nifty 50 TRI, Nifty200 Momentum 30 TRI). */
export interface MomentumComparison {
  name: string;
  cagr: number | null;
  excess_cagr: number | null;
  max_drawdown: number | null;
  note: string | null;
  series: Array<number | null>;
}

/** An upper-circuit run a held stock went through in the backtest. */
export interface MomentumCircuitEpisode {
  symbol: string;
  direction: 'LC' | 'UC';
  start: string;
  end: string;
  days: number;
  band_pct: number;
  /** Cumulative move over the locked sessions, percent. */
  move_pct: number;
  /** Share of the portfolio held when the lock began, percent. */
  portfolio_share_pct: number;
  /** share x move, percent of the whole portfolio. */
  portfolio_impact_pct: number;
  /** A UC run covering the day the backtest bought: not fillable for real. */
  blocked_entry: boolean;
  /** Times the backtest held this stock through the same lock. */
  times_held: number;
}

/** A lower-circuit run that began while the strategy still held the stock. */
export interface MomentumCircuitTrapped {
  symbol: string;
  start: string;
  end: string;
  days: number;
  band_pct: number;
  /** Fall over the locked sessions themselves, percent. */
  move_pct: number;
  /** sold_during = the sale was filled on a locked day, which live would have been blocked. */
  exit: 'sold_during' | 'sold_after' | 'still_held';
  exit_date: string | null;
  /** Move from the first locked day to the day the strategy actually sold, percent. */
  realised_move_pct: number;
  portfolio_share_pct: number;
  portfolio_impact_pct: number;
}

/** A lower-circuit run on a stock the strategy had already sold shortly before it began. */
export interface MomentumCircuitEscaped {
  symbol: string;
  start: string;
  end: string;
  days: number;
  band_pct: number;
  move_pct: number;
  exit_date: string;
  days_before: number;
  portfolio_share_pct: number;
  /** What the lock would have cost at the position size it had just sold, percent. */
  avoided_impact_pct: number;
}

export interface MomentumCircuitRunStats {
  cagr: number;
  max_drawdown: number;
  total_return: number;
  trades: number;
}

/** The same backtest with circuit locks ignored and respected. */
export interface MomentumCircuitRealism {
  /** True when this run's own numbers are the "respecting" ones. */
  this_run_respects_locks: boolean;
  ignoring_locks: MomentumCircuitRunStats;
  respecting_locks: MomentumCircuitRunStats;
  /** respecting - ignoring, as a fraction (0.02 = 2 points of CAGR). */
  cagr_impact: number;
}

export interface MomentumCircuitExposure {
  realism?: MomentumCircuitRealism;
  positions: number;
  /** Holdings that met at least one band-edge close. */
  touched: number;
  episodes: number;
  blocked_entries: number;
  blocked_exits: number;
  lc: MomentumCircuitTrapped[];
  uc: MomentumCircuitEpisode[];
  lc_escaped: MomentumCircuitEscaped[];
  lc_trapped_count: number;
  lc_escaped_count: number;
  lc_trapped_sold_during: number;
}

/** The heavy parts of a result a background run leaves out until something asks for them. */
export type MomentumSectionName =
  | 'trades'
  | 'instruments'
  | 'timeline'
  | 'latest'
  | 'circuit_exposure';

export interface MomentumLatest {
  week: string;
  explain: string;
  rows: Array<{
    asset: string;
    rank: number | null;
    score: number | null;
    action: string;
    held: boolean;
    returns: Record<string, number | null>;
  }>;
}

export interface MomentumResult {
  benchmark_name: string;
  kpis: Record<string, number | string | null>;
  comparisons?: MomentumComparison[];
  series: MomentumSeries;
  rotations: MomentumRotation[];
  /** A background run's result holds the core only: each section below is `undefined` until
   * fetched (its name is in `sections_available`). A whole result from the synchronous endpoint
   * has them all. */
  sections_available?: MomentumSectionName[];
  latest?: MomentumLatest;
  open_positions: Array<Record<string, unknown>>;
  trades?: Array<Record<string, unknown>>;
  instruments?: Array<Record<string, unknown>>;
  timeline?: Array<Record<string, unknown>>;
  yearly: Array<Record<string, unknown>>;
  crashes: Array<Record<string, unknown>>;
  held_categories?: Array<{ position: number; status: string; category: string; picks: string[] }>;
  missing_symbols?: string[];
  /** Broad Momentum only; null when it couldn't be computed. */
  circuit_exposure?: MomentumCircuitExposure | null;
  skipped_categories?: string[];
  fills?: { proxy_trades: number; warnings: string[] };
}

export interface MomentumSavedRun {
  id: string;
  created_at: string;
  n: number;
  name: string;
  config: Record<string, unknown>;
  kpis: Record<string, number | null>;
  dates: string[];
  strategy: Array<number | null>;
  overlay: boolean;
  /** Included in every scheduled weekly evaluation. */
  favorite: boolean;
  /** The sole favourite whose result is delivered to Telegram. */
  active: boolean;
}

export interface MomentumWeeklyRunResult {
  title: string;
  body: string;
  severity: string;
  sent_to_telegram: boolean;
  signal: Record<string, unknown> | null;
  strategies?: Array<{
    id: string | null;
    name: string;
    dataset: 'etf' | 'stock' | 'custom_index' | 'broad';
    active: boolean;
    blocked: string | null;
    title: string | null;
    body: string | null;
    signal: Record<string, unknown> | null;
  }>;
}

/** A manual weekly run, executed in the background by the Momentum service. */
export interface MomentumWeeklyJob {
  id: string;
  run: 'preview' | 'final';
  send: boolean;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  finished_at: string | null;
  result: MomentumWeeklyRunResult | null;
  error: string | null;
}

/** How far each weekly input is ingested, plus recent signals and scheduled runs. */
export interface MomentumWeeklyStatus {
  today: string;
  /** The Friday-labelled week a final run would produce a signal for. */
  target_week: string;
  datasets: Array<{
    key: 'etf' | 'stock';
    label: string;
    through: string | null;
    ready: boolean;
    note: string;
    error: string | null;
  }>;
  signals: Array<{ week: string; run: 'preview' | 'final'; label: string; generated_at: string }>;
  schedule: Array<{
    run: 'preview' | 'final' | 'stock-ingest' | 'journal-check';
    when: string;
    last_ran_at: string | null;
    last_line: string | null;
    /** Set when the job fired more than ~10 minutes after its scheduled time — typically
     * the laptop was asleep; launchd runs it on wake with no catch-up marker of its own. */
    ran_late_by_minutes: number | null;
  }>;
}

/** A background `mbt stocks sync` run (bhavcopy fetch + shared-DB migrate), triggered from
 * the Data panel's "Refresh stock data" button. */
export interface MomentumStockSyncJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  finished_at: string | null;
  result: { ok: true } | null;
  error: string | null;
}

export interface MomentumStockActionReview {
  counts: { confirmed: number; crash: number; review: number };
  manual_review_after: string;
  pending_count: number;
  items: Array<{
    symbol: string;
    ex_date: string;
    previous_close: number;
    close: number;
    previous_volume: number;
    volume: number;
    previous_turnover: number;
    turnover: number;
    implied_factor: number | null;
    suggested_factor: number | null;
    confirmed_factor: number | null;
    cumulative_factor: number | null;
    status: 'review' | 'confirmed' | 'crash';
    event_kind: string | null;
    subject: string | null;
  }>;
}

export interface MomentumRebalanceResult {
  dataset: 'stock' | 'broad';
  as_of: string;
  signal_week: string;
  price_mode: 'live' | 'last_close';
  price_source: string;
  portfolio_value: number;
  first_allocation: boolean;
  rebalance_schedule: {
    strategy_start_date: string;
    cadence: 'weekly' | 'every_n_weeks' | 'monthly';
    interval_weeks: number | null;
    effective_rebalance_offset: number | null;
    is_rebalance_week: boolean;
    previous_rebalance_date: string | null;
    current_rebalance_date: string | null;
    next_rebalance_date: string;
  } | null;
  current_pct: Record<string, number>;
  target_pct: Record<string, number>;
  rows: Array<{
    asset: string;
    symbol: string | null;
    action: 'BUY' | 'SELL';
    current_pct: number;
    target_pct: number;
    delta_pct: number;
    ltp: number | null;
    indicative_value: number;
    indicative_quantity: number | null;
  }>;
  note: string;
}

/** GET /api/momentum/journal — the forward-signal journal (BL-024). */
export interface MomentumJournalEntry {
  entry_id: number;
  /** ISO 8601 UTC. */
  recorded_at: string;
  week: string;
  run_kind: 'preview' | 'final';
  source: 'favourite' | 'benchmark';
  config_id: string;
  config_name: string;
  dataset: string;
  settings_hash: string;
  /** git HEAD, with '+dirty' when the code had uncommitted changes. */
  code_commit: string;
  data_fingerprint: string;
  /** entry_id of the row this one corrects, if any. */
  supersedes: number | null;
  prev_hash: string;
  row_hash: string;
  /** Model portfolio (fractions) at the signal's close, BEFORE the signal's own actions. */
  holdings_before: Record<string, number>;
  actions: Array<{ asset: string; action: string; rank: number | null }>;
  /** Benchmark rows only: the index level recorded. */
  level: number | null;
}

export interface MomentumJournalCheckItem {
  config_id: string;
  name: string;
  dataset: string;
  run_kind: 'preview' | 'final';
  status: 'recorded' | 'wrong_week' | 'missing';
  entry_id: number | null;
  week: string | null;
  recorded_at: string | null;
  corrections: number;
}

export interface MomentumJournalCheck {
  week: string;
  expected: number;
  recorded: number;
  items: MomentumJournalCheckItem[];
  chain: { entries: number; head: string | null; problems: string[] };
  warnings: string[];
  ok: boolean;
}

export interface MomentumJournal {
  /** False until the first weekly run has created the journal. */
  available: boolean;
  weeks: Array<{ week: string; entries: number }>;
  week: string | null;
  entries: MomentumJournalEntry[];
  check: MomentumJournalCheck | null;
}
