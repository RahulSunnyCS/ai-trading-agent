/**
 * `GET /api/backtest/legwise/rotation/lot-plans?book=core|t1` (BL-135,
 * `packages/option-backtesting/.../rotation/lot_plans.py`). Hand-kept in sync with that module.
 */

export type LotPlanBook = 'core' | 't1';
export type LotPlanId = 'as_picked' | 'dir_boost' | 'duo';
export type LotPlanStatus = 'scored' | 'waiting' | 'late' | 'unverified';

export interface LotPlanLeg {
  name: string;
  lots: number;
  /** One-lot gross of the strategy that day; null while its result is not stored. */
  gross: number | null;
  n_trades: number | null;
  /** The best unpicked Dir added on a three-Widesl day. */
  runner_up: boolean;
}

export interface LotPlanDay {
  lots: LotPlanLeg[];
  /** null when the plan's strategies are not known (unverified). */
  total_lots: number | null;
  status: 'scored' | 'waiting' | 'unverified';
  gross: number | null;
  brokerage: number | null;
  net: number | null;
}

export interface LotPlanPick {
  name: string;
  family: 'widesl' | 'dir' | 'other';
  composite: number | null;
  w1: boolean;
}

export interface LotPlanRow {
  day: string;
  book: LotPlanBook;
  weekday: string;
  expiry: boolean;
  dte: { NIFTY: string; SENSEX: string };
  expiry_only: string | null;
  recorded_at: string | null;
  status: LotPlanStatus;
  note: string | null;
  picks: LotPlanPick[];
  runner_up_dir: { verified: boolean; dir: string | null; note: string | null } | null;
  plans: Record<LotPlanId, LotPlanDay>;
}

export interface LotPlanSummary {
  plan: LotPlanId;
  name: string;
  days: number;
  lot_days: number;
  mean_lots: number | null;
  gross: number;
  brokerage: number;
  net: number;
  gross_per_day: number | null;
  brokerage_per_day: number | null;
  net_per_day: number | null;
  max_drawdown: number | null;
  worst_day: { day: string; net: number } | null;
  /** Lots of today's entry; null when today has no entry yet. */
  lots_today: number | null;
}

export interface LotPlanReadoutPlan {
  name: string;
  diff_per_day: number;
  lo90: number;
  hi90: number;
  dd_per_lot: number;
  comparator_dd_per_lot: number;
  verdict: 'beats' | 'costs' | 'inconclusive';
}

export type LotPlanReadout =
  | { status: 'n/a'; days: number; needed: number }
  | {
      status: 'judged';
      days: number;
      judged_days: number;
      from: string;
      to: string;
      plans: Partial<Record<LotPlanId, LotPlanReadoutPlan>>;
      after_readout?: { days: number; diff_per_day: Partial<Record<LotPlanId, number>> };
    };

export type LotPlanCumulativePoint = { day: string } & Record<LotPlanId, number>;

export interface RotationLotPlansResponse {
  book: LotPlanBook;
  list: string;
  forward_from: string;
  today: string;
  plans: LotPlanSummary[];
  comparator: LotPlanId;
  counts: Record<LotPlanStatus, number> & { entries: number };
  cumulative: LotPlanCumulativePoint[];
  rows: LotPlanRow[];
  readout: LotPlanReadout;
  chain: { intact: boolean; problems: string[] };
  message: string | null;
}
