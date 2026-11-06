/**
 * `GET /legwise/rotation/live-board` (BL-203, `rotation/live_board.py`): today's Adaptive picks run
 * through the backtest engine on Angel One's bars so far. Rupee figures are per lot unless named
 * `yours`; `net_slipped` carries the Rotation pages' 0.5% slippage on every fill.
 */

export type LivePickState = 'waiting' | 'open' | 'closed' | 'no_data';

export interface LiveLeg {
  leg: string;
  /** "23600CE 03Nov" */
  contract: string;
  expiry: string;
  strike: number;
  option_type: 'CE' | 'PE';
  side: 'buy' | 'sell';
  qty: number;
  /** HH:MM */
  entry: string;
  entry_price: number;
  /** HH:MM, null while the leg is held */
  exit: string | null;
  /** The exit price, or the last bar's close while held */
  price: number | null;
  /** "open", "SL", "EXIT_TIME", … */
  reason: string;
  pnl: number;
}

export interface LivePick {
  variant: string;
  label: string;
  params: string;
  role: 'core' | 'buy';
  underlying: string;
  entry_time: string;
  exit_time: string;
  state: LivePickState;
  legs: LiveLeg[];
  gross: number;
  net: number;
  net_slipped: number;
  worst_mtm: number;
  stopped_by: string | null;
  /** [session minute (0 = 09:15), MTM ₹ at one lot] */
  curve: [number, number][];
  /** The lots every account that trades this list holds of it (0 = not traded) */
  lots?: number;
  strikes_sure?: boolean;
}

export interface LiveBookTotals {
  net: number;
  net_slipped: number;
}

export interface LiveBook {
  book: 'core' | 't1';
  name: string;
  late: boolean;
  expiry_only: string | null;
  dte: Record<string, string> | null;
  /** "quantiply · angelone ×1" */
  accounts: string[];
  picks: LivePick[];
  per_lot: LiveBookTotals;
  yours: LiveBookTotals & { lots: number };
  curve: [number, number][];
  curve_yours: [number, number][];
}

export interface LiveSpot {
  last: number | null;
  open: number | null;
  as_of: string;
}

export interface LiveBoardSnapshot {
  v: number;
  day: string;
  refreshed_at: string;
  /** HH:MM: the board is as at the end of the bar before this minute */
  as_of: string | null;
  source: string;
  slippage_pct: number;
  spot: Record<string, LiveSpot>;
  books: LiveBook[];
  notes: string[];
  requests?: number;
  took_s?: number;
  by?: string;
}

export interface LiveBoardState {
  refreshing?: boolean;
  started_at?: string;
  by?: string;
  last_ok_at?: string;
  last_error?: string | null;
  last_error_at?: string;
  last_note?: string | null;
  /** Stamped when any refresh finishes, whatever its outcome */
  last_done_at?: string;
}

export interface LiveBoardResponse {
  today: string;
  snapshot: LiveBoardSnapshot | null;
  state: LiveBoardState;
  loop: { running: boolean; every_s?: number | null; next_at?: string | null };
}

export interface LiveBoardRefreshResponse {
  /** `no_picks`: before the day's 09:16 entry; nothing was read and no login was made. */
  status: 'requested' | 'started' | 'no_picks';
  started_at?: string;
  day?: string;
}
