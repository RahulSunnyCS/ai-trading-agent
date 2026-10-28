/**
 * GET /api/momentum/journal/forward (BL-024 Phases 2-3): the forward score the Friday 20:30 job
 * stores (`forward_score.py`) and the real Kite fills reconciled live (`forward_fills.py`).
 * Returns are fractions (0.012 = 1.2%); a null figure is not available, never a zero.
 */

export interface ForwardFigures {
  ideal: number | null;
  achievable: number | null;
}

export interface ForwardGaps {
  now: ForwardFigures;
  recorded: ForwardFigures;
}

export type ForwardStatus = 'scored' | 'waiting' | 'mismatch' | 'late' | 'not_scored';

export interface ForwardItem {
  config_id: string;
  name: string;
  dataset: string;
  run_kind: 'preview' | 'final';
  week: string;
  next_week: string;
  entry_id: number | null;
  recorded_at: string | null;
  corrections: number[];
  status: ForwardStatus;
  reason: string | null;
  mismatches: string[];
  live: ForwardFigures & { cost: number | null };
  backtest: { recorded: number | null; recorded_note: string | null; now: number | null };
  gap: ForwardGaps;
  benchmark: number | null;
  ranking: string | null;
  sleeve_value: number | null;
}

export interface ForwardGroup {
  group_id: string;
  name: string;
  week: string;
  members: number;
  scored: number;
  status: 'scored' | 'incomplete';
  live: ForwardFigures;
  backtest: { recorded: number | null; now: number | null };
  gap: ForwardGaps;
  benchmark: number | null;
  ranking: string | null;
}

export interface ForwardScore {
  items: ForwardItem[];
  groups: ForwardGroup[];
  weeks: string[];
  scored_weeks: string[];
  computed_at: string;
  code_commit: string;
  ranking_now: string;
  rerun: boolean;
}

export type FillStatus = 'done' | 'shares differ' | 'missed' | 'extra' | 'held';

export interface FillRow {
  symbol: string;
  signal_action: string | null;
  target_weight: number | null;
  model_shares: number | null;
  plan_shares: number | null;
  plan_price: number | null;
  side: 'buy' | 'sell';
  shares: number | null;
  shares_first_day: number | null;
  avg_first_day: number | null;
  shares_later: number | null;
  avg_later: number | null;
  difference: number | null;
  friday_close: number | null;
  next_open: number | null;
  vs_close_bps: number | null;
  vs_open_bps: number | null;
  vs_plan_bps: number | null;
  charges: number | null;
  model_charges: number | null;
  booked: string[];
  days: string[];
  note: string | null;
  status: FillStatus;
}

export interface FillRebalance {
  lot: string;
  sleeve_id: string;
  week: string;
  next_session: string | null;
  first_week: boolean;
  new_lot: boolean;
  first_trade_day: string | null;
  entry_id: number;
  recorded_at: string;
  budget: number;
  budget_from: string;
  orders_at: string | null;
  plan_differs: string[];
  rows: FillRow[];
  totals: {
    bought: number;
    sold: number;
    real_charges: number;
    model_charges: number;
    slippage_close_rs: number | null;
    slippage_open_rs: number | null;
    slippage_plan_rs: number | null;
  };
  booked_pending: boolean;
  slippage_bps: number | null;
}

export interface FillGroup {
  group_id: string;
  name: string;
  rebalances: FillRebalance[];
  outside_lots: {
    day: string;
    time: string;
    symbol: string;
    side: string;
    qty: number;
    price: number;
  }[];
  unmatched_claims: { lot: string; symbol: string; shares: number; source: string }[];
}

export interface ForwardView {
  score: ForwardScore | null;
  fills: {
    paper_start: string | null;
    groups: FillGroup[];
    computed_at: string | null;
  } | null;
  fills_error: string | null;
  paper_start: string | null;
}
