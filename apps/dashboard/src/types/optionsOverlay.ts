/** BL-227: Momentum › Options overlay. Mirrors `momentum_backtesting/options_overlay.py`. */

export type OverlayDirection = 'calls' | 'puts' | 'mirror' | 'switch' | 'both';
export type OverlaySizing = 'one_lot' | 'premium' | 'capital_share' | 'exposure';
export type OverlayMoneyness = 'ITM2' | 'ITM1' | 'ATM' | 'OTM1' | 'OTM2' | 'OTM3' | 'DELTA';
export type OverlayCallFilter = 'none' | 'nifty_200dma' | 'nifty_26w' | 'breadth';
export type OverlayMarketFilter = 'nifty_200dma' | 'nifty_26w' | 'breadth';

/** A custom Broad strategy on F&O stocks (the research grid's settings plus these). */
export interface OverlayCustom {
  lookbacks: number[];
  top_n: number;
  exit_rank: number;
  rebalance: 'weekly' | 'fortnightly' | 'monthly';
  score: 'ranksum' | 'voladj';
}

export interface OverlayRequest {
  favourite_id: string | null;
  /** Instead of a favourite. */
  custom: OverlayCustom | null;
  direction: OverlayDirection;
  moneyness: OverlayMoneyness;
  sizing: OverlaySizing;
  sizing_value: number | null;
  capital: number;
  n: number;
  min_sessions_left: number;
  min_oi_lots: number;
  slippage: number | null;
  tax: boolean;
  market_filter: OverlayMarketFilter;
  put_share: number;
  start: string;
  end: string | null;
  /** Profit booking: every this many rupees made, `withdraw_share` of it is taken out (null = off). */
  profit_step: number | null;
  withdraw_share: number;
  /** With profit booking: move taken-out money back when the account cannot pay for a pick. */
  refill: boolean;
  /** Keep a contract while its stock is still picked (rolled near expiry). */
  hold: boolean;
  /** Moneyness DELTA: the strike whose delta is nearest this. */
  delta_target: number;
  /** 0 = nearest expiry with enough sessions left, 1 = the one after, ... */
  expiry_skip: number;
  /** Exit on a daily close this share below / above the entry premium (null = off). */
  stop: number | null;
  target: number | null;
  call_filter: OverlayCallFilter;
  max_positions: number | null;
  max_weekly_premium: number | null;
  /** Train / test split day (null = none). */
  split: string | null;
}

export interface OverlayWindow {
  first?: string;
  last?: string;
  weeks: number;
  total_rs?: number;
  total?: number;
  cagr?: number | null;
  max_dd?: number;
  weekly_90?: [number, number] | null;
  trades?: number;
  win_rate?: number | null;
  top5pct_share?: number | null;
  net_without_top5pct_rs?: number;
}

export interface OverlayStrategy {
  id: string;
  name: string;
  status: string | null;
  active: boolean;
  sleeves: number;
  held_n: number[];
}

export interface OverlayStrategies {
  strategies: OverlayStrategy[];
  data_through: string | null;
}

export interface OverlayTrade {
  entry: string;
  exit: string;
  symbol: string;
  right: 'CE' | 'PE';
  leg: string;
  expiry: string;
  strike: number;
  spot: number;
  spot_exit: number | null;
  lot: number;
  lots: number;
  p0: number;
  p1: number;
  exit_how: 'same' | 'restruck' | 'zero' | 'stop' | 'target';
  /** Weeks the position was kept (1 = bought and sold within the week). */
  weeks?: number;
  /** The rebalance day whose week the sale belongs to (a stop can sell mid-week). */
  week_end?: string;
  buy: number;
  sell: number;
  costs: number;
  pnl: number;
}

export interface OverlayBookFigures {
  total: number;
  total_rs?: number;
  cagr: number | null;
  max_dd: number;
  dd_peak?: string;
  dd_trough?: string;
}

export interface OverlayResult {
  settings: OverlayRequest & { slippage: number };
  strategy: string | null;
  favourite_id: string | null;
  data_through: string;
  first_day: string;
  last_day: string;
  weeks: number;
  book: OverlayBookFigures & {
    total_rs: number;
    before_tax_rs: number;
    tax_rs: number;
    costs_rs: number;
    weekly_90: [number, number] | null;
    went_below_zero: boolean;
  };
  shares: (OverlayBookFigures & { total_rs: number }) | null;
  nifty: OverlayBookFigures | null;
  series: {
    days: string[];
    options: number[];
    shares?: number[];
    nifty?: number[];
    drawdown: number[];
  };
  min_capital: {
    weekly_premium: { median: number; p90: number; max: number } | null;
    one_lot?: { median: number; p90: number; max: number };
    positions_per_week?: { median: number; max: number };
    worst_fall_rs: number | null;
    suggested_rs: number | null;
  };
  stats: {
    trades: number;
    win_rate?: number;
    avg_win_rs?: number | null;
    avg_loss_rs?: number | null;
    payoff?: number | null;
    weeks_won?: number | null;
    net_before_tax_rs?: number;
    top5pct_share?: number | null;
    net_without_top5pct_rs?: number;
    best?: OverlayTrade[];
    worst?: OverlayTrade[];
  };
  by_stock: Array<{
    symbol: string;
    trades: number;
    net_rs: number;
    win_rate: number;
    best_rs: number;
    worst_rs: number;
    premium_rs: number;
  }>;
  by_year: Array<{
    year: number;
    before_tax_rs: number;
    after_tax_rs: number;
    trades: number;
    win_rate: number | null;
    calls_rs: number;
    puts_rs: number;
    shares_return?: number | null;
  }>;
  sides: {
    calls: { trades: number; net_rs: number };
    puts: { trades: number; net_rs: number };
    weeks_down?: number;
    weeks_up?: number;
  };
  counts: Record<string, number>;
  trades: OverlayTrade[];
  windows: { split: string; train: OverlayWindow; test: OverlayWindow } | null;
  booking: {
    profit_step: number;
    withdraw_share: number;
    account: number[];
    taken: number[];
    refill: boolean;
    /** Out, less what went back in. */
    taken_rs: number;
    out_rs: number;
    in_rs: number;
    account_end_rs: number;
    bookings: Array<{ day: string; kind: 'out' | 'in'; amount_rs: number; account_rs: number }>;
  } | null;
}

export interface OverlayJob<R = OverlayResult> {
  id: string;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  finished_at: string | null;
  result: R | null;
  error: string | null;
  error_status: number | null;
}

export interface OverlaySweepStatus {
  name: string;
  total: number;
  done: number;
  todo: number;
  workers: number;
  started: string;
  finished?: string;
  running: boolean;
}

export interface OverlaySweepRow {
  id: string;
  label: string | null;
  settings: Partial<OverlayRequest> & Record<string, unknown>;
  book?: { total_rs: number; total: number; cagr: number | null; max_dd: number };
  shares?: { total: number; max_dd: number } | null;
  windows?: { split: string; train: OverlayWindow; test: OverlayWindow } | null;
  stats?: { trades: number; win_rate: number | null; top5pct_share: number | null };
  min_capital?: number | null;
  error?: string;
  secs?: number;
}

/** Fresh starts: the page's settings started afresh with the capital on many days. */
export interface OverlayStartsRequest extends OverlayRequest {
  every_months: 1 | 3 | 6;
  years: number;
  /** A start washed out when its account fell below this share of the capital. */
  washout: number;
}

export interface OverlayStart {
  start: string;
  first_day: string;
  last_day: string;
  /** Capital plus the after-tax total, money taken out included. */
  end_rs: number;
  taken_rs: number;
  /** The trading account's lowest week-end (before tax). */
  low_rs: number;
  washed_out: boolean;
  max_dd: number;
  trades: number;
  /** Picks the account could not pay for. */
  unaffordable: number;
}

export interface OverlayStartsResult {
  settings: OverlayRequest & { slippage: number };
  strategy: string | null;
  favourite_id: string | null;
  data_through: string;
  every_months: number;
  years: number;
  washout: number;
  washout_rs: number;
  skipped: number;
  summary: {
    starts: number;
    median_end_rs: number;
    mean_end_rs: number;
    best_rs: number;
    worst_rs: number;
    above_start: number;
    washed_out: number;
    median_trades: number;
  } | null;
  starts: OverlayStart[];
}
