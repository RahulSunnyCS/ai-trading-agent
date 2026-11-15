/** BL-227: Momentum › Options overlay. Mirrors `momentum_backtesting/options_overlay.py`. */

export type OverlayDirection = 'calls' | 'puts' | 'mirror' | 'switch' | 'both';
export type OverlaySizing = 'one_lot' | 'premium' | 'capital_share';
export type OverlayMoneyness = 'ATM' | 'OTM1' | 'OTM2' | 'OTM3';
export type OverlayMarketFilter = 'nifty_200dma' | 'nifty_26w' | 'breadth';

export interface OverlayRequest {
  favourite_id: string | null;
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
  exit_how: 'same' | 'restruck' | 'zero';
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
  booking: {
    profit_step: number;
    withdraw_share: number;
    account: number[];
    taken: number[];
    taken_rs: number;
    account_end_rs: number;
    bookings: Array<{ day: string; taken_rs: number; account_rs: number }>;
  } | null;
}

export interface OverlayJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  finished_at: string | null;
  result: OverlayResult | null;
  error: string | null;
  error_status: number | null;
}
