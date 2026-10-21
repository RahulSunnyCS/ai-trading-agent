/**
 * The Rotation page's "Live vs paper" card (BL-141 Phase 3): `GET /legwise/rotation/live`, built by
 * `rotation/live_compare.py` (`compare_range`). Every figure is computed there; money is ₹ per lot
 * after the same estimated costs on both sides, slippage = live − paper (+ live did better).
 */

export type LivePlatform = 'algotest' | 'quantiply';

/** One platform + broker + list on one day: the per-lot sums of its compared variants. */
export interface LiveGroup {
  platform: string;
  broker: string;
  book: string | null;
  live: number;
  paper: number;
  slippage: number;
  slippage_pct: number | null;
  variants: number;
}

export interface LiveCompared {
  platform: string;
  broker: string;
  book: string | null;
  variant: string;
  copies: number;
  lots: number;
  live: number;
  live_per_lot: number;
  paper: number | null;
  costs: number;
  slippage: number | null;
  slippage_pct: number | null;
  premium_per_lot: number | null;
  multiplier_guessed: boolean;
}

export interface LiveDay {
  day: string;
  captured: boolean;
  failed_sections: { platform: string; broker: string; error: string | null }[];
  groups: LiveGroup[];
  compared: LiveCompared[];
  /** variant ids, for the badges */
  no_paper: string[];
  off_slot: string[];
  open_legs: string[];
  not_traded: string[];
  unrecognised: string[];
  discretionary_count: number;
  discretionary_total: number;
}

export interface LiveRunningPoint {
  day: string;
  live: number;
  paper: number;
  slippage: number;
}

export interface LiveRunning {
  platform: string;
  broker: string;
  book: string | null;
  live: number;
  paper: number;
  slippage: number;
  days: number;
  points: LiveRunningPoint[];
}

export interface LiveShape {
  platform: string;
  position: 'sell' | 'buy';
  band: string;
  variant_days: number;
  slippage: number;
  mean_slippage: number;
  /** null when fills (hence the premium) are not known: Quantiply */
  slippage_pct: number | null;
}

export interface RotationLiveResponse {
  from: string | null;
  to: string | null;
  captured_days: string[];
  days: LiveDay[];
  running: LiveRunning[];
  shapes: LiveShape[];
  discretionary: { total: number; points: { day: string; value: number }[] };
}
