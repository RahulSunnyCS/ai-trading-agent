/**
 * Wire types for Options Lab › Rotation › "Why this pick?" and "Does rank predict results?".
 * Shapes come from `GET /legwise/rotation/explain` and `/ic` (`rotation/explain.py`,
 * `rotation/rankic.py`). Hand-duplicated from the Python side, like the other legwise types.
 */

export type RotationListKey = 'A' | 'B' | 'C' | 'REF';

/** The criteria of the composite, in the order the widgets show them. */
export type RotationCriterion = 'recent' | 'weekday' | 'dte' | 'vix' | 'rfam';

export type RotationPickRole =
  | 'core'
  | 'core_override'
  | 'buy'
  | 'other'
  /** A pick the journal recorded, shown beside the rebuilt ones. */
  | 'recorded_core'
  | 'recorded_buy';

/** The journal's hash chain as the widgets show it. */
export interface RotationChain {
  intact: boolean;
  problems: string[];
  /** The journal could not be read at all. */
  error: string | null;
}

export interface RotationFitWindow {
  lookback: number;
  weight: number;
  matching_days: number;
  /** Mean per-lot result on the matching days; null when none match. */
  mean: number | null;
  /** This window's part of the fit value, in rupees per lot. */
  part: number;
}

export interface RotationCriterionRow {
  /** The raw criterion in rupees per lot (the rupee-denominated recent score or fit). */
  value: number;
  /** Rank among the variants / n: 1.0 is the best. */
  pct: number;
  weight: number;
  /** weight x pct: this criterion's points of the composite. */
  contribution: number;
  windows?: RotationFitWindow[];
  /** Matching days in the longest window (fits only). */
  matching_days?: number;
  /** The family band whose recent scores are averaged (rfam only). */
  group?: string;
}

export interface RotationVariantRow {
  variant: string;
  index: 'NIFTY' | 'SENSEX';
  family: string;
  kind: 'wide' | 'dir' | 'buy';
  /** "09:17" */
  slot: string;
  role: RotationPickRole;
  /** Among all variants. */
  rank: number;
  /** Among the non-Buy pool the core is drawn from; null for a Buy variant. */
  pool_rank: number | null;
  composite: number;
  criteria: Record<RotationCriterion, RotationCriterionRow>;
  family_band: string | null;
}

export interface RotationVariantRef {
  variant: string;
  index: string;
  family: string;
  kind: string;
  slot: string;
  /** Among all variants: what the Buy test counts. */
  rank: number;
  /** Among the non-Buy pool: what the core and the Widesl minimum count; null for a Buy variant. */
  pool_rank: number | null;
  composite: number;
}

export interface RotationExcluded extends RotationVariantRef {
  /** Weakest pick's composite minus this one's; negative = it outscored a pick. */
  gap: number;
  kept_out_by: 'widesl_minimum' | null;
}

export interface RotationBoundary {
  n_core: number;
  min_wide: number;
  override: {
    fired: boolean;
    wide_in_unconstrained: number;
    swaps: { dropped: RotationVariantRef; added: RotationVariantRef }[];
  };
  unconstrained_core: RotationVariantRef[];
  weakest_pick: RotationVariantRef;
  best_excluded: RotationExcluded | null;
  nearest_excluded: RotationExcluded[];
  buy: {
    top: number;
    size: number;
    qualified: boolean;
    picked: RotationVariantRef[];
    best_buy: RotationVariantRef | null;
    tenth_composite: number | null;
    gap_to_top: number | null;
  };
}

export interface RotationReconstruction {
  source: 'recorded' | 'reconstructed';
  /** null on a day with no journal entry (nothing to match). */
  matches: boolean | null;
  max_abs_diff: number | null;
  picks_equal: boolean | null;
  overridden_equal: boolean | null;
  /** Recorded names that are not among the rebuilt variants at all. */
  missing_in_rebuild: string[];
  inputs_sha_recorded: string | null;
  inputs_sha_rebuilt: string;
  inputs_match: boolean | null;
  universe_match: boolean | null;
  note?: string;
}

export interface RotationProvenance {
  source: 'recorded' | 'reconstructed';
  recorded_at?: string | null;
  before_first_entry?: boolean | null;
  hash?: string | null;
  commit?: string | null;
  vix_source?: string | null;
  dte_source?: string | null;
}

/** One pick the journal recorded, with the rebuild's view of it. */
export interface RotationRecordedPick {
  variant: string;
  role: 'core' | 'buy';
  recorded_composite: number | null;
  rebuilt_composite: number | null;
  rebuilt_rank: number | null;
  rebuilt_pool_rank: number | null;
  /** The rebuild picks it too. */
  rebuilt_pick: boolean;
  /** Its breakdown now (null when the variant is not in the rebuilt universe). */
  row: RotationVariantRow | null;
}

export interface RotationExplainRange {
  /** Every day that can be explained, ascending. */
  days: string[];
  recorded: string[];
  first: string | null;
  last: string | null;
  default: string | null;
  results_through: string | null;
  journal_error: string | null;
  chain: RotationChain;
}

export interface RotationExplain {
  day: string;
  list: RotationListKey;
  list_info: {
    name: string;
    description: string;
    weights: Record<RotationCriterion, number>;
    lookbacks: { days: number; weight: number }[];
    n_core: number;
    lots_per_strategy: number;
  };
  criteria: { key: RotationCriterion; label: string }[];
  context: {
    weekday: string;
    vix_open: number | null;
    vix_band: string;
    dte: { NIFTY: string; SENSEX: string };
    source: 'journal' | 'days.csv';
  };
  history: { days: number; from: string; to: string; digest: string };
  n_variants: number;
  reconstruction: RotationReconstruction;
  provenance: RotationProvenance;
  recorded: {
    core: string[];
    buy: string[];
    overridden: boolean | null;
    composite: Record<string, number>;
  } | null;
  recorded_picks: RotationRecordedPick[];
  chain: RotationChain;
  picks: RotationVariantRow[];
  top: RotationVariantRow[];
  boundary: RotationBoundary;
  scored: { n: number; picked_gross: Record<string, number> } | null;
  warnings: string[];
  available: RotationExplainRange;
}

// ---------------------------------------------------------------------------
// Rank correlation
// ---------------------------------------------------------------------------

export type RotationIcKey = RotationCriterion | 'composite';
export type RotationIcDayKind = 'forward' | 'late' | 'research';

export interface RotationIcDay {
  day: string;
  kind: RotationIcDayKind;
  composite: number | null;
  recent: number | null;
  weekday: number | null;
  dte: number | null;
  vix: number | null;
  rfam: number | null;
  /** Variants with a result that day. */
  n: number;
  /** Mean gross per lot of the top 30 and bottom 30 by composite, and the difference. */
  top: number | null;
  bottom: number | null;
  spread: number | null;
  /** The rebuilt picks equal the journal entry's (null on a day with no entry). */
  matches_entry: boolean | null;
}

export interface RotationIcSummary {
  n: number;
  mean: number | null;
  sd: number | null;
  se: number | null;
  lo: number | null;
  hi: number | null;
  /** The Student t critical value the band used (n - 1 degrees of freedom). */
  t: number | null;
  /** The band is on enough days to be read (n >= min_band_days). */
  readable: boolean;
  /** Share of days above zero. */
  pos: number | null;
}

export interface RotationIcRunning {
  day: string;
  n: number;
  mean: number | null;
  lo: number | null;
  hi: number | null;
}

export interface RotationIcReference {
  list: RotationListKey;
  from: string;
  to: string;
  variants: number;
  source: string;
  values: Partial<Record<RotationIcKey, number>>;
}

export interface RotationIc {
  list: RotationListKey;
  mode: 'forward' | 'research';
  from: string | null;
  to: string | null;
  n_days: number;
  n_variants: number;
  days: RotationIcDay[];
  running: RotationIcRunning[];
  summary: Record<RotationIcKey | 'spread', RotationIcSummary>;
  reference: RotationIcReference | null;
  status: {
    entries: number;
    forward: number;
    late: number;
    forward_scored: number;
    forward_waiting: string[];
    results_through: string | null;
    journal_error: string | null;
    chain: RotationChain;
  };
  /** Why there is nothing to show (an empty forward window), in words. */
  reason: string | null;
  warmup: number;
  spread_n: number;
  min_band_days: number;
  chain: RotationChain;
  counts: { forward: number; late: number; research: number; mismatch: number };
}
