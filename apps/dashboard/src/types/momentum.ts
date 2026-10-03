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

export interface MomentumResult {
  benchmark_name: string;
  kpis: Record<string, number | string | null>;
  comparisons?: MomentumComparison[];
  series: MomentumSeries;
  rotations: MomentumRotation[];
  latest: {
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
  };
  open_positions: Array<Record<string, unknown>>;
  trades: Array<Record<string, unknown>>;
  instruments: Array<Record<string, unknown>>;
  timeline: Array<Record<string, unknown>>;
  yearly: Array<Record<string, unknown>>;
  crashes: Array<Record<string, unknown>>;
  held_categories?: Array<{ position: number; status: string; category: string; picks: string[] }>;
  missing_symbols?: string[];
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
    run: 'preview' | 'final' | 'stock-ingest';
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
  price_source: string;
  portfolio_value: number;
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
