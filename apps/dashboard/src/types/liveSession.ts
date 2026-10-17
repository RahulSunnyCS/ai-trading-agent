/** `/api/backtest/legwise/live/*` (live/session.py): one day on the 1-minute grid. */

export type LiveUnderlying = 'NIFTY' | 'SENSEX';

export interface LiveDaysResponse {
  underlying: LiveUnderlying;
  /** Collected days with option data, newest first (YYYY-MM-DD). */
  days: string[];
}

export interface LiveStatus {
  available: boolean;
  /** Why there is no live feed, in words the page shows. */
  reason: string;
}

export interface StraddleSide {
  ce: Array<number | null>;
  pe: Array<number | null>;
  straddle: Array<number | null>;
}

export interface LiveSessionResponse {
  underlying: LiveUnderlying;
  day: string;
  source: { kind: 'replay' | 'live'; note: string };
  live: LiveStatus;
  /** The nearest listed weekly expiry (YYYY-MM-DD) both straddles are on. */
  expiry: string;
  /** Weekdays from the day to the expiry (BL-109). */
  dte_weekdays: number;
  strike_step: number;
  /** Index of the last minute with data on the 09:15 = 0 grid. */
  last_minute: number;
  /** Epoch seconds (UTC) of each minute from 09:15 IST. */
  minutes: number[];
  spot: {
    open: number | null;
    close: Array<number | null>;
    high: Array<number | null>;
    low: Array<number | null>;
  };
  vix: Array<number | null> | null;
  /** The ATM strike of each minute's spot. */
  atm: Array<number | null>;
  /** The straddle at each minute's own ATM strike: it re-strikes as the index moves. */
  rolling: StraddleSide;
  /** The straddle at the strike that was ATM at the 09:15 open, held all day. */
  fixed: StraddleSide & { strike: number | null; open_value: number | null };
  range: {
    median_sessions: number;
    median_full_session: number | null;
    full_session: number | null;
  };
  notes: string[];
}
