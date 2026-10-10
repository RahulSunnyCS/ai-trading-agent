/**
 * Wire types of `GET /api/backtest/legwise/rotation/matrix` and `.../matrix/cell`
 * (packages/option-backtesting `rotation/matrix.py`). Hand-duplicated, as the repo does for every
 * Python response: when the Python side changes, change this file with it.
 */

export type MatrixView =
  | 'family_slot'
  | 'date_slot'
  | 'dte_slot'
  | 'vix_family'
  | 'weekday_family'
  | 'pulse';

export type MatrixMetric = 'avg' | 'win_rate' | 'stop_rate' | 'worst' | 'selection';
export type MatrixPeriodId = 'P1' | 'P2' | 'P3' | 'forward' | 'custom';
export type MatrixListId = 'A' | 'B' | 'C' | 'REF';
export type MatrixBasis = 'all' | 'selected';
export type MatrixUnit = 'inr' | 'fraction';
/** ok is omitted from a cell; na = the strategy does not exist here. */
export type MatrixCellStatus = 'missing' | 'excluded' | 'na';

export interface MatrixCellMetrics {
  avg: number | null;
  stop_rate: number | null;
  win_rate?: number | null;
  worst?: number | null;
}

export interface MatrixCell {
  /** The chosen metric; absent when the cell has no value (see `st`). */
  v?: number | null;
  /** Distinct sessions pooled. */
  n?: number;
  /** Variant-days pooled. */
  nv?: number;
  thin?: boolean;
  st?: MatrixCellStatus;
  reason?: string;
  m?: MatrixCellMetrics;
  /** Picks per list among the scored recorded variant-days in this cell. */
  sel?: Partial<Record<MatrixListId, number>>;
  /** Scored recorded variant-days in this cell (the denominator of `sel`). */
  rec?: number;
}

export interface MatrixDiffCell {
  v?: number | null;
  n?: [number, number];
  nv?: [number, number];
  thin?: boolean;
  st?: MatrixCellStatus;
  reason?: string;
}

export interface MatrixAxisItem {
  key: string;
  label: string;
  index?: string;
  family?: string;
  slot?: string;
  date?: string;
  weekday?: string;
  dte?: string;
  vix_band?: string;
  window?: number | null;
}

export interface MatrixScale {
  kind: 'diverging' | 'sequential';
  min: number;
  max: number;
  limit: number;
  clipped: boolean;
}

export interface MatrixPeriodMeta {
  id: MatrixPeriodId;
  label: string;
  from: string | null;
  to: string | null;
  status: 'ok' | 'unavailable';
  reason: string | null;
  sessions: number | null;
  waiting_on_results: string[] | null;
}

export interface MatrixGrid {
  period: MatrixPeriodId;
  status: 'ok' | 'unavailable';
  reason: string | null;
  sessions?: number;
  cells?: MatrixCell[][];
  row_summary?: (MatrixCell | null)[] | null;
  col_summary?: (MatrixCell | null)[] | null;
}

export interface MatrixDifference {
  status: 'ok' | 'unavailable';
  reason?: string | null;
  minuend?: MatrixPeriodId;
  subtrahend?: MatrixPeriodId;
  cells?: MatrixDiffCell[][];
  scale?: MatrixScale;
  unit?: MatrixUnit;
  note?: string;
}

export interface MatrixOverlay {
  source: 'recorded';
  available: boolean;
  reason: string | null;
  entries: number;
  on_time: number;
  late: string[];
  scored: number;
  waiting_on_results: string[];
  lists: MatrixListId[];
  reconstructed: string;
}

export interface MatrixMeta {
  slots: string[];
  families: { index: string; family: string; key: string; label: string }[];
  weekdays: string[];
  dte: string[];
  vix_bands: string[];
  store: {
    variants: number;
    first: string | null;
    last: string | null;
    sessions: number;
    days_without_attributes: string[];
  };
  lists: Record<MatrixListId, string>;
  journal: { available: boolean; reason: string | null; on_time: number; late: number };
}

export interface MatrixFiltersEcho {
  index: 'NIFTY' | 'SENSEX' | 'both';
  family: string[] | null;
  slot: string[] | null;
  weekday: string[] | null;
  dte: string[] | null;
  vix_band: string[] | null;
}

export interface MatrixResponse {
  available: true;
  view: MatrixView;
  metric: MatrixMetric;
  basis: MatrixBasis;
  list: MatrixListId | null;
  unit: MatrixUnit;
  metric_label: string;
  aggregation: string;
  selection_denominator: string | null;
  filters: MatrixFiltersEcho;
  min_n: number;
  rows: MatrixAxisItem[];
  cols: MatrixAxisItem[];
  periods: MatrixPeriodMeta[];
  matrices: MatrixGrid[];
  scale: MatrixScale | null;
  difference: MatrixDifference | null;
  overlay: MatrixOverlay;
  /** Per date row: the lists that picked each start time (recorded entries only). */
  date_picks: Record<string, { late: boolean; cells: Record<string, MatrixListId[]> }> | null;
  as_of: string | null;
  meta: MatrixMeta;
  all_periods: MatrixPeriodMeta[];
  notes: string[];
}

export interface MatrixUnavailable {
  available: false;
  reason: string;
  meta: MatrixMeta;
}

export type MatrixResult = MatrixResponse | MatrixUnavailable;

export interface MatrixCellDay {
  day: string;
  weekday: string;
  gross: number;
  n_variants: number;
  n_stopped: number;
  stopped_by?: string;
  worst_mtm?: number | null;
  picked_by?: MatrixListId[];
}

export interface MatrixCellVariant {
  name: string;
  n: number;
  avg: number | null;
  win_rate: number | null;
  worst: number | null;
  settings?: {
    id?: string | null;
    entry?: string | null;
    exit?: string | null;
    strike?: string | null;
    position?: string | null;
    legs?: number;
    leg_stop_percent?: number | null;
    overall_stop_inr?: number | null;
    square_off?: string | null;
  };
}

export interface MatrixCellDetail {
  view: MatrixView;
  row: { key: string; label: string };
  col: { key: string; label: string };
  period: MatrixPeriodId;
  period_label: string;
  basis: MatrixBasis;
  list: MatrixListId | null;
  pooling: string;
  stats: {
    sessions: number;
    variant_days: number;
    avg?: number | null;
    win_rate?: number | null;
    stop_rate?: number | null;
    worst?: number | null;
    best?: number | null;
    median_day?: number | null;
    worst_day?: string;
    best_day?: string;
    cumulative?: number | null;
    max_drawdown?: number | null;
  };
  days: MatrixCellDay[];
  cumulative: { day: string; cum: number | null }[];
  variants: MatrixCellVariant[];
  variants_total: number;
  overlay: MatrixOverlay;
}
