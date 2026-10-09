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

/**
 * One of the five indices the headline benchmark picker offers (`reference_benchmarks.PICKER`),
 * all dividend-inclusive. `series` is in rupees on `series.dates`, rebased to ₹1 lakh like the
 * strategy; the statistics use the strategy's own definitions (Sharpe and Sortino vs cash). An
 * index without data for this run is listed with `available` false and a `reason`.
 */
export type MomentumBenchmarkChoice =
  | {
      name: string;
      available: false;
      /** Why: no data, starts after the run's first week, ends early, or a gap over a week. */
      reason?: string;
    }
  | {
      name: string;
      available: true;
      /** The index's last real close on or before the final week (it may be carried a week). */
      as_of: string;
      note: string | null;
      series: Array<number | null>;
      cagr: number | null;
      excess_cagr: number | null;
      total_return: number | null;
      final_value: number | null;
      volatility: number | null;
      sharpe: number | null;
      sortino: number | null;
      max_drawdown: number | null;
      max_drawdown_trough: string | null;
      /** Calendar years the strategy beat this index. */
      years_beating: number | null;
    };

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
  /** The headline picker's five indices; absent on results computed before 2026-10-07. */
  benchmarks?: MomentumBenchmarkChoice[];
  series: MomentumSeries;
  rotations: MomentumRotation[];
  /** Whether the server answered from its result cache (then `computed_at` is when it was
   * actually computed), as opposed to computing it for this request. */
  cache?: { hit: boolean; computed_at: string };
  /** What the result was computed from (BL-052): data and code fingerprints, sent back when the
   * run is saved so a later move can be explained. */
  versions?: MomentumRunVersions | null;
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
  /** The headline (BL-051): the one followed favourite whose result is delivered to Telegram. */
  active: boolean;
  /** Watching / Paper / Invested; null for a non-favourite and for a group member. */
  status: FavouriteStatus | null;
  /** A group (BL-051): the ids of the saved runs it is made of; null for an ordinary run. */
  group: string[] | null;
  /** The group this run belongs to, if any: it then follows the group's status. */
  member_of: string | null;
  /** `/favorite-strategies` only: a group's members' full records. */
  members?: MomentumSavedRun[];
  /** BL-052: the normalised-settings hash; runs sharing it are one strategy. */
  fingerprint?: string | null;
  versions?: MomentumRunVersions | null;
  data_through?: string | null;
  /** Against the strategy's previous run: a new strategy, the same result again, or a new one. */
  outcome?: 'new' | 'repeat' | 'new_result' | null;
}

/** Why a saved strategy's result moved (BL-052, `saved_identity.explain`). */
export type ResultChangeLabel =
  | 'data_revised'
  | 'intended'
  | 'check'
  | 'not_reproducible'
  | 'unknown';

/** One row of the append-only result-change log (`momentum_result_changes`). */
export interface ResultChange {
  change_id: string;
  created_at: string;
  dataset: string;
  version_id: string;
  anchor_run_id: string;
  prev_run_id: string;
  run_id: string;
  label: ResultChangeLabel;
  prev_versions: MomentumRunVersions | null;
  versions: MomentumRunVersions | null;
  /** What differs in the data: catalog table names, "stock lake files", "input files". */
  changed: string[] | null;
  /** First week the two curves disagree, 'YYYY-MM-DD'. */
  first_difference: string | null;
  kpis_before: Record<string, number | null>;
  kpis_after: Record<string, number | null>;
  /** `reason`: the accepted golden change's reason, for `intended`. */
  detail: { reason?: string } | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  /** A Check or Not reproducible change nobody has marked reviewed. */
  needs_review: boolean;
}

/** How far a strategy's result can be trusted (`runs_store._trust`). */
export type StrategyTrust = 'validated' | 'not_tradable' | 'old_data' | 'in_sample';

/** One saved strategy: every run of one set of normalised settings (BL-052). Its id is the
 * anchor run's, which holds the name, notes and favourite state. */
export interface SavedStrategy {
  id: string;
  version_id: string;
  dataset: string;
  fingerprint: string;
  name: string;
  /** False for a placeholder ("Run 12"): the dashboard shows an automatic name instead. */
  name_typed: boolean;
  notes: string | null;
  config: Record<string, unknown>;
  /** `config` with every request default spelled out: what the runs used. Open and re-run
   * take this, so the form shows exactly the strategy that ran. */
  config_full: Record<string, unknown>;
  favorite: boolean;
  active: boolean;
  status: FavouriteStatus | null;
  group: string[] | null;
  member_of: string | null;
  overlay: boolean;
  runs: number;
  repeats: number;
  first_saved: string;
  last_run: string;
  latest: {
    id: string;
    created_at: string;
    kpis: Record<string, number | null>;
    dates: string[];
    strategy: Array<number | null>;
    data_through: string | null;
    versions: MomentumRunVersions | null;
    outcome: 'new' | 'repeat' | 'new_result' | null;
  };
  /** The change the latest run made, when it moved the result. */
  change: ResultChange | null;
  /** Check / Not reproducible changes of this strategy nobody has reviewed. */
  unreviewed: number;
  /** Null for a group (it has no result of its own). */
  trust: StrategyTrust | null;
  /** A group's members, each a strategy of its own. */
  members?: SavedStrategy[];
  /** `/saved-strategies/{id}` only: every run, newest first. */
  history?: SavedStrategyRun[];
}

export interface SavedStrategyRun {
  id: string;
  created_at: string;
  n: number | null;
  name: string | null;
  kpis: Record<string, number | null>;
  data_through: string | null;
  versions: MomentumRunVersions | null;
  outcome: 'new' | 'repeat' | 'new_result' | null;
  change: ResultChange | null;
}

export interface SavedStrategiesResponse {
  strategies: SavedStrategy[];
  /** Check / Not reproducible changes nobody has reviewed, across every strategy. */
  unreviewed: number;
  /** Per dataset, the settings it never reads (left out of names and differences). */
  ignored_fields: Record<string, string[]>;
}

/** What saving a finished run did (BL-052): the record plus how it joined its strategy. */
export interface MomentumSaveOutcome extends MomentumSavedRun {
  strategy_ref?: { id: string; name: string | null; name_typed: boolean; favourite: boolean };
  change?: ResultChange | null;
}

/** A run's data and code fingerprints (BL-052, `saved_identity.versions_from_input`). */
export interface MomentumRunVersions {
  data: string;
  tables: Record<string, string>;
  lake: string;
  files: string;
  code: string;
  /** "at_save" when the result did not carry them and the server measured them on saving. */
  measured?: string;
}

/** How closely a favourite is followed (BL-051). Paper + Invested together are capped. */
export type FavouriteStatus = 'watching' | 'paper' | 'invested';

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
    /** A favourite group's combined outcome (BL-051); its sleeves are listed separately. */
    group?: boolean;
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
    run: 'preview' | 'final' | 'stock-ingest' | 'journal-check' | 'live-rules';
    when: string;
    last_ran_at: string | null;
    last_line: string | null;
    /** Set when the job fired more than ~10 minutes after its scheduled time — typically
     * the laptop was asleep; launchd runs it on wake with no catch-up marker of its own. */
    ran_late_by_minutes: number | null;
    /** The scheduler's exit code for its latest run of this job, and when it ended (BL-051). */
    last_exit_code?: number | null;
    last_exit_at?: string | null;
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
  /** Why a market-hours preview used stored closes instead of live prices; null otherwise. */
  live_unavailable?: string | null;
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

// --- This week (BL-051) ---------------------------------------------------------------------

/** One name on a favourite's card: what the signal does with it this week. */
export interface MomentumWeekRow {
  asset: string;
  /** BUY, SELL, TRIM, ADD, HOLD, or an engine action such as TOP UP / WAIT. */
  action: string;
  /** The strategy's own rank (a group: the rank in the sleeve that acted on it). */
  rank: number | null;
  rank_prev?: number | null;
  held: boolean;
  /** Share of the portfolio after this week's trades. */
  after?: number | null;
  /** Groups only: share before the trades, and the sleeves holding or trading it. */
  before?: number;
  sleeves?: string[] | null;
}

/** One configuration inside a group, and its rebalance cadence. */
export interface MomentumWeekSleeve {
  id: string;
  name: string;
  value?: number;
  on_cadence?: boolean;
  every?: number | null;
  offset?: number | null;
  next?: string | null;
}

export interface MomentumWeekEdgeName {
  asset: string;
  rank: number;
  rank_prev?: number | null;
}

/** Next week's likely trades: the weakest names held and the strongest not held. */
export interface MomentumWeekEdge {
  /** Groups: the sleeve that trades next, and when. */
  sleeve: string | null;
  on: string | null;
  weakest_held: MomentumWeekEdgeName[];
  strongest_not_held: MomentumWeekEdgeName[];
}

export interface MomentumWeekCard {
  id: string;
  name: string;
  status: FavouriteStatus | null;
  headline: boolean;
  dataset: string;
  group: boolean;
  sleeves: MomentumWeekSleeve[] | null;
  run: 'preview' | 'final' | null;
  recorded_at: string | null;
  blocked: string | null;
  rows: MomentumWeekRow[];
  held: string[];
  cash: number | null;
  exit_rank: number | null;
  explain: string | null;
  edge: MomentumWeekEdge | null;
  since_preview: {
    added: Array<{ asset: string; action: string }>;
    dropped: Array<{ asset: string; action: string }>;
  } | null;
  trades: number;
  shared_with_headline: number | null;
}

/** The message a weekly run produced for the headline, as sent (or held back). */
export interface MomentumWeekMessage {
  week: string | null;
  run: string;
  title: string;
  body: string;
  sent: boolean;
  headline: string | null;
  at: string;
}

/** `GET /api/momentum/week`. */
export interface MomentumWeekView {
  week: string;
  target_week: string;
  /** Weeks with journal entries, newest first. */
  weeks: string[];
  favourites: MomentumWeekCard[];
  message: MomentumWeekMessage | null;
}

export interface MomentumLiveRulesFinding {
  rule: 'drawdown' | 'trailing' | 'money_gate' | 'stage' | 'data';
  level: 'ok' | 'breach' | 'pending' | 'ready' | 'unmeasurable' | 'blocked';
  title: string;
  detail: string;
  action: string | null;
  needs_you: boolean;
}

/** The latest live-money rules check (BL-025), as the 21:30 job or a manual check saved it. */
export interface MomentumLiveRulesReport {
  checked_at: string;
  severity: string;
  title: string;
  stage: string;
  week: string | null;
  weeks: number;
  breached: boolean;
  /** The week the check should have covered, when its data was older. */
  stale: string | null;
  numbers: Partial<{
    drawdown: number;
    worst_drawdown: number;
    peak_week: string;
    cut_half_at: number;
    exit_at: number;
    weeks: number;
    min_paper_weeks: number;
    return: number;
    benchmark_return: number;
    must_beat: string;
    trailing_window_weeks: number;
    review_when_behind_pts: number;
  }>;
  findings: MomentumLiveRulesFinding[];
}

/** `GET /api/momentum/live-rules`. */
export interface MomentumLiveRules {
  report: MomentumLiveRulesReport | null;
  job: {
    id: string;
    status: 'running' | 'done' | 'failed';
    started_at: string;
    finished_at: string | null;
    error: string | null;
  } | null;
}

export type MomentumAlertKind = 'split' | 'data' | 'journal' | 'change' | 'rules';
export type MomentumAlertSeverity = 'error' | 'warning' | 'info';

/** One thing that needs a person (`GET /api/momentum/alerts`). The id is stable (kind + subject). */
export interface MomentumAlert {
  id: string;
  kind: MomentumAlertKind;
  severity: MomentumAlertSeverity;
  title: string;
  detail: string;
  /** An in-app path with its query, where the alert is acted on. */
  link: string;
  opened_at: string | null;
  resolved_at: string | null;
}

export interface MomentumAlertsResponse {
  checked_at: string;
  /** Open alerts, most severe first. */
  alerts: MomentumAlert[];
  /** The latest ones that cleared. */
  resolved: MomentumAlert[];
  /** Kinds that could not be checked this time; their open alerts are kept. */
  unchecked: MomentumAlertKind[];
}
