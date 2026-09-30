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

export interface MomentumResult {
  benchmark_name: string;
  kpis: Record<string, number | string | null>;
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
  n: number;
  name: string;
  config: Record<string, unknown>;
  kpis: Record<string, number | null>;
  dates: string[];
  strategy: Array<number | null>;
  overlay: boolean;
}

export interface MomentumWeeklyRunResult {
  title: string;
  body: string;
  severity: string;
  sent_to_telegram: boolean;
  signal: Record<string, unknown> | null;
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
