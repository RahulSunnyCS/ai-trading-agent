/**
 * `GET /legwise/rotation/regime` (rotation/regime.py): the forward window's market mix beside the
 * research periods. Describes markets; tests nothing.
 */

export type RegimePeriodId = 'P1' | 'P2' | 'P3' | 'forward';
export type RegimeRowKey = 'vix_band' | 'dte_n' | 'dte_s' | 'weekday';

export interface RegimeMix {
  categories: string[];
  counts: number[];
  n: number;
}

export interface RegimeQuantiles {
  n: number;
  p10: number | null;
  p50: number | null;
  p90: number | null;
}

export interface RegimePeriod {
  id: RegimePeriodId;
  label: string;
  /** ok | empty (no sessions yet) | unavailable (its data is not in the store). */
  status: 'ok' | 'empty' | 'unavailable';
  reason: string | null;
  from: string | null;
  to: string | null;
  n: number;
  mix: Record<RegimeRowKey, RegimeMix> | null;
  vix_open: RegimeQuantiles | null;
  range: Record<'NIFTY' | 'SENSEX', RegimeQuantiles> | null;
}

export interface RegimeDistanceRow {
  key: RegimeRowKey;
  label: string;
  /** Total-variation distance to each research period (null when either side is empty). */
  to: Record<string, number | null>;
  /** The nearer period's id, "neither" inside the tie band, or null with nothing to compare. */
  closer: string | null;
}

export interface RotationRegimeResponse {
  periods: RegimePeriod[];
  rows: { key: RegimeRowKey; label: string; categories: string[] }[];
  distances: {
    rows: RegimeDistanceRow[];
    overall: Record<string, number | null>;
    closer: string | null;
    tie: number;
  } | null;
  forward_days: number;
  thin_days: number;
  thin: boolean;
  range_definition: string;
  basis: 'sessions';
}
