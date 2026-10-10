/**
 * Wire types of `GET /legwise/rotation/pulse` (the Family pulse card, `rotation/pulse.py`).
 * Hand-written, as the dashboard imports nothing from the Python side. Every rupee figure is gross
 * per ONE lot of one strategy; a figure the store could not give is `null` with its reason, never
 * zero.
 */

export type PulseListKey = 'A' | 'B' | 'C' | 'REF';
export type PulseKind = 'wide' | 'dir' | 'buy';
export type PulseBand = 'A' | 'B' | 'C' | 'D';
export type PulseIndex = 'both' | 'NIFTY' | 'SENSEX';

export interface PulseStat {
  st: 'ok' | 'missing';
  avg: number | null;
  /** distinct sessions in the window: the sample that matters */
  n: number;
  /** variant-days pooled */
  nv: number;
  /** distinct variants with a value in the window */
  variants: number;
  reason?: string;
  first?: string;
  last?: string;
  /** how many of the window's sessions are recorded on-time forward days */
  forward?: number;
}

export type PulseFlagState = 'above' | 'below' | 'inside' | 'unknown';

export interface PulseFlag {
  state: PulseFlagState;
  /** rolling-21 windows entirely inside P1 */
  windows: number;
  reason?: string;
  p10?: number;
  p90?: number;
  last21?: number;
}

export interface PulseChip {
  list: PulseListKey;
  variant: string;
  role: 'core' | 'buy';
}

export interface PulseShareCell {
  /** core picks of the focus list that landed in the cell */
  core: number;
  /** of all core picks in the window; null for a Buy cell (the Buy is an add-on, not a core pick) */
  share: number | null;
  /** sessions on which the Buy add-on was in this cell */
  buy_days: number;
}

export interface PulseMatrixLink {
  view: 'pulse';
  family: string;
  slot: string;
  index: 'NIFTY' | 'SENSEX' | null;
}

export interface PulseCell {
  key: string;
  kind: PulseKind;
  band: PulseBand;
  label: string;
  kind_label: string;
  /** "09:17-10:02" */
  band_label: string;
  slots: string[];
  variants: number;
  st: 'ok' | 'na';
  reason?: string;
  windows?: Record<'5' | '21' | '63', PulseStat>;
  p1?: PulseStat;
  p2?: PulseStat;
  spark?: { days: string[]; values: Array<number | null>; p1_mean: number | null };
  flag?: PulseFlag;
  rank?: { value: number; rank: number; of: number } | null;
  chips?: PulseChip[];
  share?: { recorded: PulseShareCell | null; reconstructed: PulseShareCell | null };
  matrix?: PulseMatrixLink;
}

export interface PulseShareSummary {
  sessions: number;
  core_total: number;
  list: PulseListKey;
  from: string;
  to: string;
}

export interface PulseChain {
  intact: boolean;
  problems: string[];
  error: string | null;
}

export interface PulseAvailable {
  available: true;
  basis: 'gross';
  as_of: string;
  as_of_requested: string | null;
  store: { first: string; last: string; sessions: number; weekend_excluded: string[] };
  next_pick_day: string | null;
  list: PulseListKey;
  index: PulseIndex;
  windows: number[];
  periods: Record<'P1' | 'P2', { label: string; from: string; to: string }>;
  rank: {
    available: boolean;
    reason: string | null;
    history_days: number;
    history_to: string | null;
    of: number;
    basis: 'net';
    for: string | null;
    /** the family-band criterion's weight in each list's composite */
    weights: Record<PulseListKey, number>;
  };
  picks: {
    source: 'recorded' | 'reconstructed' | null;
    day: string | null;
    late: boolean;
    lists: Partial<Record<PulseListKey, Array<{ variant: string; role: 'core' | 'buy' }>>>;
  };
  share: {
    list: PulseListKey;
    sessions: number;
    recorded: PulseShareSummary | null;
    reconstructed: PulseShareSummary | null;
  };
  journal: { entries: number; on_time: number; late: string[]; chain: PulseChain };
  flag_rule: string;
  cells: PulseCell[];
}

export interface PulseUnavailable {
  available: false;
  reason: string;
  basis: 'gross';
}

export type PulseResponse = PulseAvailable | PulseUnavailable;
