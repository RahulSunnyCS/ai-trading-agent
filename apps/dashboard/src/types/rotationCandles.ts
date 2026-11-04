/** `GET /legwise/rotation/candles` (rotation/candles.py): one book's daily candles. */

export type CandleBook = 't1' | 'core' | 'base';

export interface CandlePick {
  name: string;
  /** the self-explaining name the Telegram messages use (`N_widesl_OTM1`) */
  label: string;
  /** its settings (`SL115% · TSL15%/10% · REnone · MTMSL2500`) */
  params: string;
  lots: number;
  /** the pick's result for the day at its lots, cut at the book stop when it fired */
  pnl: number;
}

export interface CandleDay {
  day: string;
  /** recorded (the journal's picks), rederived (before the journal began) or fixed (the base) */
  source: 'recorded' | 'rederived' | 'fixed';
  open: number;
  high: number;
  low: number;
  close: number;
  pnl: number;
  /** the minute the book stop fired ("12:24"), else null */
  stopped_at: string | null;
  picks: CandlePick[];
  /** share (0-1) of random same-size baskets from the pool the day beat; null when not drawn */
  beat: number | null;
  pool: number;
}

export interface RotationCandlesResponse {
  book: CandleBook;
  from: string;
  to: string;
  lots: number;
  /** the book stop in rupees at these lots, or null for none */
  stop: number | null;
  slippage_pct: number | null;
  draws: number;
  days: CandleDay[];
  left_out: { day: string; reason: string }[];
  totals: { pnl: number; days: number; max_drawdown: number; drawdown_now: number };
}
