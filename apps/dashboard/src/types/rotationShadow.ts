/**
 * The Shadow scoreboard's response (`GET /api/backtest/legwise/rotation/shadow`, built by
 * `rotation/shadow.py`): BL-083's triggers as event minus placebo, the override against the pick it
 * displaces, and BL-081's forward candidates. Every figure is gross rupees and an event minus a
 * comparator; a missing value is `null` with its reason, never zero.
 */

export type ShadowTrigger = 'T1' | 'T2' | 'T3' | 'T4';
export type ShadowTemplate = 'wide' | 'dir' | 'buy';
export type ShadowListKey = 'A' | 'B' | 'C' | 'REF';

/** One cell of BL-083's research event study (₹ per lot, t day-clustered). */
export interface ShadowResearchCell {
  explore?: number;
  explore_t?: number;
  confirm?: number;
  confirm_t?: number;
  explore_days?: number;
  explore_nifty?: number;
  explore_nifty_t?: number;
  /** T3 is quoted by its bound: |t| at most this. */
  explore_t_bound?: number;
  confirm_t_bound?: number;
}

export interface ShadowTriggerRow {
  trigger: ShadowTrigger;
  template: ShadowTemplate;
  label: string;
  template_label: string;
  /** Dir after T1 and after T4: the two registered override candidates. */
  candidate: boolean;
  events_seen: number;
  days_seen: number;
  events: number;
  days: number;
  event_avg: number | null;
  placebo_avg: number | null;
  diff: number | null;
  t: number | null;
  /** Fewer than 5 event days: t is not shown. */
  thin: boolean;
  unscored_events: number;
  research: ShadowResearchCell | null;
}

export type ShadowStatus = 'scored' | 'pending' | 'not_applied' | 'late_entry' | 'no_entry';

export interface ShadowDayRow {
  day: string;
  list: ShadowListKey;
  candidate: boolean;
  trigger: ShadowTrigger;
  underlying: string;
  /** HH:MM, the minute the Dir would have entered. */
  entry: string;
  detail: string | null;
  status: ShadowStatus;
  reason: string;
  displaced: string | null;
  displaced_start: string | null;
  displaced_gross: number | null;
  dir_net: number | null;
  /** Dir at the event minus the displaced pick, one lot. */
  diff_lot: number | null;
  /** The same on the list's lots (2 per strategy). */
  diff_basket: number | null;
  placebo_dir: number | null;
  placebo_days: number;
  control_diff_basket: number | null;
}

export interface ShadowSeriesPoint {
  day: string;
  diff_basket: number;
  cum_basket: number;
  control_diff_basket?: number;
  cum_control?: number;
}

export interface ShadowListSummary {
  list: ShadowListKey;
  candidate: boolean;
  description: string;
  forward_days: number;
  event_days: number;
  scored: number;
  pending: number;
  not_applied: number;
  late_entry: number;
  no_entry: number;
  total_basket: number | null;
  mean_lot: number | null;
  beat_share: number | null;
  control_days: number;
  control_complete?: boolean;
  control_total_basket: number | null;
  series: ShadowSeriesPoint[];
}

export interface ShadowBanner {
  sessions: number;
  with_event: number;
  judged_at: number;
  remaining: number;
  first_day: string | null;
  last_day: string | null;
}

export interface ShadowResearchOverride {
  period: 'explore' | 'confirm';
  list: ShadowListKey;
  plain: number;
  override: number;
  gain: number;
  dd: number;
  dd_plain: number;
  random_time_p90: number;
  random_day_p90: number;
  above_controls: boolean;
}

export interface ShadowCandidate {
  id: string;
  list: ShadowListKey;
  title: string;
  definition: string;
  research: { explore: string; confirm: string };
  status: 'not_scored';
  reason: string;
}

export interface ShadowControl {
  status: 'recorded' | 'not_recorded';
  reason: string;
}

export interface RotationShadowResponse {
  forward_from: string;
  research_end: string;
  window: { from: string; to: string | null };
  banner: ShadowBanner;
  files: { events: boolean; sims: boolean; scored_days: boolean; journal: boolean };
  journal: {
    exists: boolean;
    entries: number;
    forward: number;
    late: number;
    chain_intact: boolean | null;
    error: string | null;
  };
  triggers: ShadowTriggerRow[];
  trigger_info: { trigger: ShadowTrigger; label: string; definition: string }[];
  override: {
    rule: {
      triggers: ShadowTrigger[];
      template: ShadowTemplate;
      candidate_lists: ShadowListKey[];
      min_lead_minutes: number;
      min_widesl: number;
      lots_per_strategy: number;
      basis: 'gross';
    };
    lists: ShadowListSummary[];
    days: ShadowDayRow[];
    controls: { random_time: ShadowControl; placebo: ShadowControl & { min_days: number } };
  };
  research: {
    periods: Record<'explore' | 'confirm', string>;
    override: ShadowResearchOverride[];
    applied: string;
    note: string;
  };
  candidates: ShadowCandidate[];
}
