/**
 * `GET /legwise/rotation/basket` (rotation/basket.py): one list's picks for a day, or the fixed
 * base, correlated over a window. The `correlation` block is the Correlation tab's own response,
 * so every figure on the preset comes from the code behind `obt rotation corr`.
 */

import type { CorrelationResponse } from './legwise';

export type BasketListKey = 'A' | 'B' | 'C' | 'REF' | 'BASE';
export type BasketWindowId = 'P1' | 'P2' | 'last63' | 'forward' | 'custom';
export type BasketSource = 'recorded' | 'reconstructed' | 'base';

export interface BasketPick {
  name: string;
  index: string | null;
  family: string | null;
  kind: 'wide' | 'dir' | 'buy' | null;
  /** "09:32", or null when the name is not a rotation variant. */
  start: string | null;
  band: string | null;
  role: 'core' | 'buy';
  lots: number;
  composite: number | null;
  has_results: boolean;
  first: string | null;
  last: string | null;
  n_days: number;
}

export interface BasketWindow {
  id: BasketWindowId;
  label: string;
  from: string | null;
  to: string | null;
  /** Days the basket has in common inside this window (absent on the window in use). */
  n_days?: number;
}

export interface RotationBasketResponse {
  list: BasketListKey;
  label: string;
  day: string | null;
  weekday: string | null;
  source: BasketSource;
  late: boolean;
  overridden: boolean;
  picks: BasketPick[];
  /** Picks with no stored results: listed, and left out of every figure. */
  omitted: string[];
  /** Columns that repeat another by construction (the base's second Widesl): drawn, not counted. */
  duplicates: string[];
  lots: number;
  windows: Record<'P1' | 'P2' | 'last63' | 'forward', BasketWindow>;
  window: BasketWindow;
  correlation: CorrelationResponse | null;
  reason: string | null;
  n_days: number;
  /** n_days >= thin_days; below it the page shows the figures muted. */
  enough: boolean;
  thin_days: number;
  all_lose_days: number | null;
  any_lose_days: number | null;
  forward_days: number;
  basis: 'gross';
  in_sample: boolean;
  notes: string[];
}
