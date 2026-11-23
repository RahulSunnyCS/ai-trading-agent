/** Responses of `GET /legwise/mcx/overview` and `/forward` (api/mcx_routes.py). */

export interface CommodityRoot {
  root: string;
  name: string;
  /** Rupees one point is worth on one lot. */
  point_value: number;
  nearest_expiry: string | null;
  future: string | null;
  weekdays_to_expiry: number | null;
  upcoming: string[];
  /** The last option expiry the contract calendar knows. */
  calendar_ends: string | null;
  days_collected: number;
  first_day: string | null;
  last_day: string | null;
  days_last_30: number;
}

export interface CommodityOverview {
  as_of: string;
  roots: CommodityRoot[];
  errors: string[];
}

export interface ForwardTrade {
  contract: string;
  leg: 'ce' | 'pe';
  side: string;
  qty: number;
  in: string | null;
  in_price: number | null;
  out: string | null;
  out_price: number | null;
  reason: string | null;
}

export interface ForwardEntry {
  day: string;
  expiry: string;
  /** Calendar days to the expiry (0 on expiry day). */
  k: number;
  season: string;
  gross: number;
  charges: number;
  net: number;
  'net_0.5pct': number | null;
  net_0pct: number | null;
  stopped_by: string | null;
  future_at_18: number | null;
  recorded_at: string;
  trades: ForwardTrade[];
  notes: string[];
}

export interface ForwardSummary {
  sessions: number;
  expiries: number;
  net: number;
  'net_0.5pct': number;
  net_0pct: number;
  profit_factor: number | null;
  expiries_up: number;
  by_expiry: Record<string, number>;
  pass_rule_met: boolean;
}

export type WindowState = 'journaled' | 'ready to score' | 'today' | 'to come' | 'waiting for data';

export interface ForwardWindow {
  expiry: string;
  sessions: { day: string; state: WindowState; k: number }[];
}

export interface SpreadContract {
  symbol: string | null;
  bid: number | null;
  ask: number | null;
  lp: number | null;
  spread_pct_of_mid: number | null;
}

export interface SpreadSnapshot {
  day: string;
  expiry?: string;
  read_at?: string;
  future?: { symbol: string; lp: number };
  atm?: number;
  contracts?: Record<string, SpreadContract>;
  error?: string;
}

export interface CommodityForward {
  as_of: string;
  rule: {
    root: string;
    cell: string;
    grid_sha: string;
    window_sessions: number;
    exits: Record<string, string>;
  };
  start_expiry: string;
  pass_rule: { expiries: number; expiries_up: number; slippage_pct: number };
  summary: ForwardSummary;
  entries: ForwardEntry[];
  window: ForwardWindow | null;
  spreads: SpreadSnapshot[];
  chain: { ok: boolean; problems: string[] };
}
