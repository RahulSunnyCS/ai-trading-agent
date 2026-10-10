/**
 * `GET /legwise/rotation/drift` (rotation/drift.py): what a list has been holding, by family,
 * index, strike method and start band, against its own past. Counts picks, not P&L.
 */

export type DriftWindowId = 'history' | 'last63' | 'last21';

export interface DriftSpan {
  from: string | null;
  to: string | null;
  n_days: number;
  recorded: number;
  reconstructed: number;
}

export interface DriftBand {
  p10: number;
  p90: number;
}

export interface DriftFlag {
  category: string;
  label: string;
  direction: 'above' | 'below';
  share: number;
  p10: number;
  p90: number;
}

export interface DriftDimension {
  key: 'kind' | 'index' | 'strike' | 'band';
  label: string;
  categories: { key: string; label: string }[];
  counts: Record<DriftWindowId, number[]>;
  shares: Record<DriftWindowId, number[]>;
  /** The list's own rolling-21-session P10 to P90 per category over P1 (null: too few windows). */
  band: (DriftBand | null)[];
  flags: DriftFlag[];
}

export interface DriftMeasure {
  key: 'distinct' | 'most_picked' | 'same_band' | 'widesl_min' | 'buy';
  label: string;
  note: string;
  /** The last 21 sessions' value (null before there are 21 sessions). */
  last21: number | null;
  /** The variant's name, on the most-picked row. */
  name: string | null;
  band: { p10: number; p90: number } | null;
  flag: 'above' | 'below' | null;
}

export interface RotationDriftResponse {
  list: 'A' | 'B' | 'C' | 'REF';
  windows: Record<DriftWindowId, DriftSpan>;
  rolling_windows: number;
  short: number;
  long: number;
  /** At least 21 sessions and enough history for a band. */
  enough: boolean;
  band_percentiles: [number, number];
  dimensions: DriftDimension[];
  concentration: DriftMeasure[];
  flags: number;
  basis: 'picks';
  in_sample: boolean;
  history_label: string;
}
