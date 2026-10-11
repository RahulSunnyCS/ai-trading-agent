/** Options Lab › Heatmap (BL-094): the shapes of `GET /legwise/heatmap*`. */

export type HeatmapViewKey = 'time_sl' | 'date_time' | 'date_sl';
export type HeatmapMetric = 'value' | 'pct';

export interface HeatmapUnderlying {
  underlying: string;
  kind: 'index' | 'stock';
  expiry: 'weekly' | 'monthly';
  first_day: string;
  last_day: string;
  days: number;
}

export interface HeatmapAvailable {
  underlyings: HeatmapUnderlying[];
  times: string[];
  stop_losses: number[];
  exit_times: string[];
  views: HeatmapViewKey[];
  metrics: HeatmapMetric[];
}

export interface HeatmapCell {
  net: number;
  ce: number;
  pe: number;
  /** Straddles behind the cell: days (a range view sums the days in it). */
  n: number;
}

export interface HeatmapResponse {
  underlying: string;
  kind: 'index' | 'stock';
  expiry: 'weekly' | 'monthly';
  view: HeatmapViewKey;
  metric: HeatmapMetric;
  unit: 'inr_per_lot' | 'points_per_share' | 'pct_of_premium';
  /** Every stock pooled (ALLSTOCKS): always % of premium. */
  pooled?: boolean;
  lot: number | null;
  exit_time: string;
  exit_times: string[];
  rows: string[];
  columns: (string | number)[];
  cells: (HeatmapCell | null)[][];
  row_totals: (HeatmapCell | null)[];
  column_totals: (HeatmapCell | null)[];
  total: HeatmapCell | null;
  days: string[];
  filters: {
    from: string | null;
    to: string | null;
    sl: number | null;
    time: string | null;
    weeks_to_expiry: number[] | null;
  };
}
