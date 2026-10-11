/**
 * Wire types of the rotation daily log: `GET /legwise/rotation/log`, `/day/{day}` and
 * `/placement` (packages/option-backtesting `rotation/daylog.py`, `api/rotation_log_routes.py`).
 * All money is gross (the stored `costs` column is zero); a list's figures are for the lots in
 * `lots`, and `per_lot_day` is what lists are compared on.
 */

export type RotationListKey = 'A' | 'B' | 'C' | 'REF';

/** `recorded`: a journal entry; `reconstructed`: a research-history day re-scored afterwards;
 * `missing`: a trading day with no entry. */
export type RotationRowSource = 'recorded' | 'reconstructed' | 'missing';

export type RotationStatus = 'scored' | 'waiting' | 'late' | 'not_recorded';

export type RotationLogSource = 'recorded' | 'reconstructed' | 'all';

export type PlacementStatus = 'placed' | 'changed' | 'not_placed';

export interface RotationPickResult {
  /** One lot, gross, in rupees. */
  gross: number;
  worst_mtm: number | null;
  stopped_by: string;
  /** `sl` when an overall stop-loss fired, `target` for an overall target, null when neither. */
  stop: 'sl' | 'target' | null;
  n_trades: number | null;
}

export interface RotationPick {
  name: string;
  index: 'NIFTY' | 'SENSEX' | null;
  family: string | null;
  /** The family class the Widesl minimum counts: Widesl (incl. closest premium), Dir or Buy. */
  kind: 'wide' | 'dir' | 'buy' | null;
  /** `09:17` */
  start: string | null;
  /** The start-time band the family-band criterion pools by: A, B, C or D. */
  band: string | null;
  role: 'core' | 'buy';
  composite: number | null;
  /** null when the day has no stored result for this strategy (never read as zero). */
  result: RotationPickResult | null;
}

export interface RotationListBlock {
  picks: RotationPick[];
  /** The Widesl minimum overrode rank on this day. */
  overridden: boolean;
  buy_qualified: boolean;
  lots: number;
  scored: boolean;
  missing: string[];
  /** The list's gross for `lots` lots; null until every pick has a stored result. */
  gross: number | null;
  per_lot_day: number | null;
  stops: number;
  targets: number;
  shared_start_band: boolean;
}

export interface RotationPlacement {
  day: string;
  list: string;
  status: PlacementStatus;
  note: string;
  at: string;
}

export interface RotationRow {
  day: string;
  weekday: string;
  source: RotationRowSource;
  status: RotationStatus;
  status_detail: string;
  /** The day has stored attributes (the nightly job collected it). */
  collected: boolean;
  scored: boolean;
  lists: Partial<Record<RotationListKey, RotationListBlock>>;
  all_identical: boolean | null;
  groups: string[][];
  vix: {
    open: number | null;
    band: string | null;
    /** fyers | angelone | given for a recorded day; history for a reconstructed one. */
    source: string | null;
  } | null;
  dte: { NIFTY: string | null; SENSEX: string | null; source: string | null } | null;
  recorded: {
    at: string | null;
    time: string | null;
    on_time: boolean;
    commit: string | null;
    hash: string | null;
    hash_short: string;
    prev_short: string;
    position: number;
    chain_ok: boolean;
  } | null;
  placement: Partial<Record<RotationListKey, RotationPlacement>>;
}

export interface RotationCounters {
  days: number;
  late: number;
  scored: number;
  waiting: number;
  not_recorded: number;
  buy_qualified: Record<RotationListKey, number>;
  widesl_minimum_applied: Record<RotationListKey, number>;
  start_band_shared: Record<RotationListKey, number>;
  all_lists_identical: number;
  lists_differ: number;
  days_with_stop: number;
  days_with_target: number;
}

export interface RotationRegisteredList {
  key: RotationListKey;
  description: string;
}

export interface RotationLog {
  as_of: string;
  today: string;
  /** True before 09:17 IST: today's entry may still come. */
  entry_window_open: boolean;
  source: RotationLogSource;
  from: string | null;
  to: string | null;
  registered: {
    first_day: string;
    record_time: string;
    cutoff_time: string;
    lots_per_strategy: number;
    lists: RotationRegisteredList[];
  };
  chain: { entries: number; intact: boolean; problems: string[]; head: string | null };
  journal_entries: number;
  last_collected_day: string | null;
  reconstructable: {
    error: string | null;
    available: number;
    first: string | null;
    last: string | null;
  };
  holidays: { day: string; name: string }[];
  rows: RotationRow[];
  counters: { recorded: RotationCounters; reconstructed: RotationCounters };
  placement_skipped_lines: number;
  basis: 'gross';
}

export interface RotationRescore {
  checked: boolean;
  note?: string;
  same_inputs?: boolean;
  same_picks?: boolean;
  differs?: string[];
}

export interface RotationDay extends RotationRow {
  entry?: {
    universe: { variants: number; sha: string } | null;
    inputs_sha: string | null;
    inputs_days: number | null;
    lots_per_strategy: number | null;
    version: number | null;
    prev: string | null;
    hash: string | null;
  };
  rescore?: RotationRescore;
  list_info: Partial<
    Record<RotationListKey, { description: string; weights: Record<string, number> }>
  >;
  placement_history: RotationPlacement[];
  journal_intact: boolean;
  basis: 'gross';
}

export interface PlacementWriteResult {
  row: RotationPlacement;
  /** False when the list already had exactly this mark and nothing was appended. */
  written?: boolean;
}
