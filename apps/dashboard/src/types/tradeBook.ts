/**
 * The Trade book's API shapes (BL-168), hand-kept in step with
 * packages/option-backtesting's `realised/views.py` and `api/contract_notes_routes.py`
 * (`/api/backtest/legwise/contract-notes/*`). Money is rupees as plain numbers; a missing figure is
 * null, never zero.
 */

/** One session: the owner's sheet row, by its own formulas (`realised/ratios.py` DayRow). */
export interface TradeBookDay {
  day: string;
  /** F&O notes read for the day. */
  notes: number;
  /** Lines that failed to read (the day stays open until they are fixed). */
  open: number;
  net: number | null;
  note_charges: number | null;
  algos: number | null;
  algo_fees: number;
  /** Q: net − algo fees. Null on a day with no note (the sheet's "N/A" rows). */
  profit: number | null;
  /** P: the notes' charges + algo fees. */
  charges: number | null;
  capital: number | null;
  capital_source: 'manual' | 'carried' | null;
  interest: number;
  deposits: number;
  withdrawals: number;
  /** R and S: running from the store's first day. */
  cumulative: number;
  drawdown: number;
  avg_profit_50: number | null;
  avg_profit_100: number | null;
  avg_charges_100: number | null;
  charge_profit_pct: number | null;
  avg_capital_100: number | null;
  profit_capital_bps: number | null;
}

export interface TradeBookSummaryBlock {
  first_day: string | null;
  last_day: string | null;
  sessions: number;
  traded_sessions: number;
  net: number;
  charges: number;
  /** The notes' own charges (charges without the algo fees, and without the fee of a day that
   * had algos but no note). */
  note_charges: number;
  algo_fees: number;
  interest: number;
  charge_profit_pct: number | null;
  max_drawdown: number;
  max_drawdown_pct: number | null;
  longest_drawdown: number;
  win_days: number;
  loss_days: number;
  win_pct: number | null;
  avg_day: number | null;
  avg_win: number | null;
  avg_loss: number | null;
  best: number | null;
  worst: number | null;
  capital: number | null;
  profit_pct: number | null;
  time_weighted_return_pct: number | null;
  deposits: number;
  withdrawals: number;
}

export interface TradeBookRatios {
  day: string;
  avg_profit_50: number | null;
  avg_profit_100: number | null;
  avg_charges_100: number | null;
  charge_profit_pct: number | null;
  avg_capital_100: number | null;
  profit_capital_bps: number | null;
}

export interface TradeBookFiscalYear {
  /** "2025-26". */
  fy: string;
  profit: number;
  pct: number | null;
  capital: number | null;
  sessions: number;
  max_drawdown: number;
  charges: number;
  algo_fees: number;
}

export interface TradeBookAccount {
  /** "broker/id". */
  account: string;
  net: number;
  charges: number;
  capital: number | null;
  profit_pct: number | null;
  charge_profit_pct: number | null;
  sessions: number;
}

export interface TradeBookSummary {
  summary: TradeBookSummaryBlock;
  ratios: TradeBookRatios | null;
  fiscal_years: TradeBookFiscalYear[];
  accounts: TradeBookAccount[];
  /** F&O notes by how their trades read: fills, summary, unmatched, none. */
  coverage: Record<string, number>;
  open_days: string[];
  last_note_day: string | null;
  problems: string[];
}

export interface TradeBookDaysResponse {
  days: TradeBookDay[];
  problems: string[];
}

export interface TradeBookMonth {
  /** "2026-04". */
  month: string;
  profit: number;
  charges: number;
  sessions: number;
  capital: number | null;
  pct: number | null;
  avg3_pct: number | null;
}

export interface TradeBookMonthsResponse {
  months: TradeBookMonth[];
}

export type TradeSource =
  | 'adaptive-core'
  | 't1'
  | 'own-algo'
  | 'manual'
  | 'unattributed'
  | 'unknown';

export interface TradeBookTrip {
  /** The day the trip closed (or expired); `entry_day` is when it opened, earlier for an
   * overnight position. */
  day: string;
  entry_day: string;
  broker: string;
  account: string;
  underlying: string;
  instrument: string;
  expiry: string | null;
  strike: number | null;
  kind: string | null;
  /** Null for a pair read from a note's summary line (the order is not printed). */
  direction: 'short' | 'long' | null;
  qty: number;
  entry_time: string | null;
  exit_time: string | null;
  entry_price: number | null;
  exit_price: number | null;
  /** The fills' sum (already net of the brokerage on each fill); null while open or unresolved. */
  pnl: number | null;
  /** The note's other charges, shared out by turnover. */
  charges: number;
  /** unresolved: the closing note could not be read, so there is no P&L. */
  status: 'closed' | 'expired' | 'open' | 'unresolved';
  fills: number;
  source_check: string | null;
  dte: number | null;
  turnover: number;
  net: number | null;
  /** Null without both fill times, or when the trip was held overnight. */
  holding_minutes: number | null;
  source: TradeSource | string;
  strategy: string | null;
  mae?: number | null;
  mfe?: number | null;
  spot_at_entry?: number | null;
  strike_from_spot?: number | null;
}

export interface TradeBookTripsResponse {
  trips: TradeBookTrip[];
  by_source: Record<string, { trips: number; net: number; won: number }>;
  turnover: Record<string, { turnover: number; profit: number; charges: number; trips: number }>;
  coverage: Record<string, number>;
}

export interface TradeBookLedgerEvent {
  day: string;
  broker: string;
  account: string | null;
  kind: 'deposit' | 'withdrawal' | 'settlement' | 'collateral_interest' | 'margin_warning' | string;
  amount?: number | null;
  shortfall?: number | null;
  utilisation_pct?: number | null;
  time?: string | null;
  margin_used?: number | null;
  margin_available?: number | null;
}

export interface TradeBookMoneyResponse {
  events: TradeBookLedgerEvent[];
  totals: Record<string, number>;
}

export interface KiteTrade {
  time?: string | null;
  symbol: string;
  side: 'buy' | 'sell' | string;
  exchange?: string | null;
  qty: number;
  price: number;
  value: number;
  brokerage?: number | null;
}

export interface KiteNote {
  day: string;
  account: string;
  eq: {
    payin_payout_obligation?: number | null;
    charges?: Record<string, number> | null;
    total_charges?: number | null;
    final_net?: number | null;
  } | null;
  trades: KiteTrade[];
}

export interface TradeBookMomentumResponse {
  notes: KiteNote[];
}

export interface TradeBookNoteLine {
  day: string;
  broker: string;
  account: string;
  status: 'note' | 'no_trade' | 'no_note' | 'failed' | string;
  source?: string;
  reason?: string;
  fno?: {
    payin_payout_obligation: number | null;
    net_brokerage: number | null;
    other_charges: number | null;
    total_charges: number | null;
    final_net: number | null;
  } | null;
  charges?: Record<string, number> | null;
  trades_check?: string | null;
  /** The number of trade rows on the note. */
  trades: number;
  skipped_segments?: unknown[];
}

export interface TradeBookIndexContext {
  open: number;
  close: number;
  gap_pct: number | null;
  range_pct: number | null;
  expiry_day: boolean;
}

export interface TradeBookDayContext {
  day: string;
  vix_open: number | null;
  vix_pct: number | null;
  indices: Record<string, TradeBookIndexContext | null>;
}

export interface TradeBookManual {
  day?: string;
  algos?: number | null;
  capital_total?: number | null;
  capital?: { finvasia?: number | null; angelone?: number | null } | null;
  capital_read_at?: Record<string, { at: string; source: string }>;
  source?: string;
  from_sheet?: string[];
}

export interface TradeBookDayDetail {
  day: string;
  row: TradeBookDay | null;
  lines: TradeBookNoteLine[];
  trips: TradeBookTrip[];
  ledger: TradeBookLedgerEvent[];
  manual: TradeBookManual | null;
  context: TradeBookDayContext;
}

/** The PUT body: a field sent as null is removed. */
export interface TradeBookInputs {
  algos?: number | null;
  capital_total?: number | null;
  capital?: { finvasia?: number | null; angelone?: number | null } | null;
}
