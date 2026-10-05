/**
 * Pure helpers for the Personalities tab: status, the per-personality performance join over
 * the trades window, sorting, readable parameters, the suggestion diff, and the edit-dialog
 * validation (including a client-side copy of the comparison-integrity rule).
 *
 * No React, no fetch. Display strings go through lib/format.ts.
 */

import type { Tone } from '../components/ui/Badge';
import type { PaperTrade, PendingSuggestion, Personality } from '../types/trading';
import { EMPTY, formatInr, formatInt, formatNumber, formatPct, toNumberOrNull } from './format';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type PersonalityState = 'active' | 'paused';

/** Active or paused (`is_active`). Frozen is separate: Clockwork is frozen and active. */
export function personalityState(p: Pick<Personality, 'is_active'>): PersonalityState {
  return p.is_active ? 'active' : 'paused';
}

export interface StateBadge {
  label: string;
  tone: Tone;
  /** What the badge means, for a title / tooltip. */
  description: string;
}

/** Badge text and tone for each state, plus Frozen. Green stays reserved for profit. */
export const STATE_BADGE: Readonly<Record<PersonalityState | 'frozen', StateBadge>> = {
  active: {
    label: 'Active',
    tone: 'info',
    description: 'Evaluates every signal and paper-trades when its filters pass.',
  },
  paused: {
    label: 'Paused',
    tone: 'neutral',
    description: 'Switched off: it sees no signals and opens no trades.',
  },
  frozen: {
    label: 'Frozen',
    tone: 'accent',
    description:
      'The fixed benchmark every other personality is compared against. Its parameters never change, by hand or by evolution.',
  },
};

/** Why the Edit button is off for a frozen personality (Clockwork). */
export const FROZEN_EDIT_REASON =
  'Clockwork is the frozen benchmark: its parameters never change, so every other personality is measured against the same rules.';

/** The rows to show: everything when `includeInactive`, otherwise active ones only. */
export function visiblePersonalities(
  personalities: readonly Personality[],
  includeInactive: boolean,
): Personality[] {
  return includeInactive ? [...personalities] : personalities.filter((p) => p.is_active);
}

// ---------------------------------------------------------------------------
// Performance join (trades window → per personality)
// ---------------------------------------------------------------------------

export interface PersonalityPerformance {
  /** Every trade in the window opened by this personality (open and closed). */
  trades: number;
  /** Closed trades. */
  closed: number;
  /** Closed trades with net P&L above zero. */
  wins: number;
  /** Sum of net P&L over closed trades (₹); null when none has a usable net P&L. */
  netPnl: number | null;
  /** wins / closed (same definition as lib/pnl.ts); null with no closed trades. */
  winRate: number | null;
}

export interface PerformanceJoin {
  byId: Map<string, PersonalityPerformance>;
  /** Trades in the window that carry no personality_id (or one not in the list). */
  unattributed: number;
}

/** The trade's personality, if the row carries one (GET /api/trades returns the raw row). */
export function tradePersonalityId(trade: PaperTrade): string | null {
  const id = trade.personality_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function emptyPerformance(): PersonalityPerformance {
  return { trades: 0, closed: 0, wins: 0, netPnl: null, winRate: null };
}

/**
 * Join the trades window to personalities by `personality_id`. Null / unparseable net P&L is
 * skipped (never counted as zero), as in lib/pnl.ts.
 */
export function joinPerformance(
  personalities: readonly Pick<Personality, 'id'>[],
  trades: readonly PaperTrade[],
): PerformanceJoin {
  const byId = new Map<string, PersonalityPerformance>();
  for (const p of personalities) byId.set(p.id, emptyPerformance());
  let unattributed = 0;

  for (const trade of trades) {
    const id = tradePersonalityId(trade);
    const perf = id === null ? undefined : byId.get(id);
    if (!perf) {
      unattributed++;
      continue;
    }
    perf.trades++;
    if (trade.status !== 'closed') continue;
    perf.closed++;
    const pnl = toNumberOrNull(trade.net_pnl);
    if (pnl === null) continue;
    perf.netPnl = (perf.netPnl ?? 0) + pnl;
    if (pnl > 0) perf.wins++;
  }

  for (const perf of byId.values()) {
    perf.winRate = perf.closed === 0 ? null : perf.wins / perf.closed;
  }
  return { byId, unattributed };
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type PersonalitySortKey = 'name' | 'status' | 'netPnl' | 'winRate' | 'trades';
export type SortDirection = 'asc' | 'desc';

export interface PersonalitySort {
  key: PersonalitySortKey;
  direction: SortDirection;
}

function statusRank(p: Personality): number {
  if (p.is_frozen) return 0;
  return p.is_active ? 1 : 2;
}

function sortValue(
  p: Personality,
  key: PersonalitySortKey,
  perf: PersonalityPerformance | undefined,
): string | number | null {
  switch (key) {
    case 'name':
      return p.display_name.toLowerCase();
    case 'status':
      return statusRank(p);
    case 'netPnl':
      return perf?.netPnl ?? null;
    case 'winRate':
      return perf?.winRate ?? null;
    case 'trades':
      return perf?.trades ?? 0;
  }
}

/** Sort rows (null = the server's seed order); missing values go last either way. Stable. */
export function sortPersonalities(
  rows: readonly Personality[],
  sort: PersonalitySort | null,
  perf: ReadonlyMap<string, PersonalityPerformance>,
): Personality[] {
  if (sort === null) return [...rows];
  const sign = sort.direction === 'asc' ? 1 : -1;
  return rows
    .map((p, index) => ({ p, index, value: sortValue(p, sort.key, perf.get(p.id)) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      if (a.value < b.value) return -sign;
      if (a.value > b.value) return sign;
      return a.index - b.index;
    })
    .map((row) => row.p);
}

/** Clicking a header: a new column starts descending for figures, ascending for text. */
export function nextSort(
  current: PersonalitySort | null,
  key: PersonalitySortKey,
): PersonalitySort {
  if (current?.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { key, direction: key === 'name' || key === 'status' ? 'asc' : 'desc' };
}

export function ariaSort(
  sort: PersonalitySort | null,
  key: PersonalitySortKey,
): 'ascending' | 'descending' | 'none' {
  if (sort?.key !== key) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

// ---------------------------------------------------------------------------
// Readable parameters
// ---------------------------------------------------------------------------

/** Labels for the keys the seed migration uses; anything else is humanised. */
const PARAM_LABELS: Readonly<Record<string, string>> = {
  min_probability: 'Minimum probability',
  reentry_min_probability: 'Re-entry minimum probability',
  sl_pct: 'Stop-loss',
  stop_loss_pct: 'Stop-loss',
  target_pct: 'Target',
  max_daily_trades: 'Max trades per day',
  max_daily_loss: 'Max loss per day',
  entry_delay_secs: 'Entry delay',
  vix_max: 'Max India VIX',
  roll_trigger_points: 'Roll trigger',
  cut_trigger_points: 'Cut trigger',
  max_open_legs: 'Max open legs',
  sr_proximity_points: 'S/R proximity',
  sr_strength_threshold: 'S/R strength threshold',
  learning_speed: 'Learning speed',
  min_samples_before_change: 'Min samples before a change',
  max_changes_per_cycle: 'Max changes per cycle',
  max_change_pct: 'Max change per step',
  cooldown_days: 'Cooldown',
};

/** Keys shown first, in this order; the rest follow alphabetically. */
const PARAM_ORDER = [
  'min_probability',
  'reentry_min_probability',
  'sl_pct',
  'stop_loss_pct',
  'target_pct',
  'max_daily_trades',
  'max_daily_loss',
];

function sentenceCase(text: string): string {
  const words = text.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** 'min_probability' → 'Minimum probability'; an unknown 'foo_bar' → 'Foo bar'. */
export function paramLabel(key: string): string {
  return PARAM_LABELS[key] ?? sentenceCase(key);
}

/** Keys whose value is a probability stored as a fraction (0–1). */
export function isProbabilityKey(key: string): boolean {
  return /probability$|_threshold$/.test(key);
}

/** A parameter value as text: probabilities as %, money as ₹, units where the key says. */
export function formatParamValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value === '' ? EMPTY : sentenceCase(value);
  if (typeof value !== 'number') return JSON.stringify(value);
  if (!Number.isFinite(value)) return EMPTY;
  if (isProbabilityKey(key) && value >= 0 && value <= 1) return formatPct(value, 0);
  if (key === 'max_daily_loss' || key.endsWith('_inr')) return formatInr(value);
  if (key.endsWith('_pct')) return `${formatNumber(value, 2, { trim: true })}%`;
  if (key.endsWith('_secs')) return `${formatInt(value)} s`;
  if (key.endsWith('_days')) return `${formatInt(value)} ${value === 1 ? 'day' : 'days'}`;
  if (key.endsWith('_points')) return `${formatNumber(value, 2, { trim: true })} pts`;
  return formatNumber(value, 2, { trim: true });
}

export interface ParamEntry {
  key: string;
  label: string;
  value: string;
}

/** Every parameter as a readable row, important keys first. */
export function paramEntries(params: Readonly<Record<string, unknown>>): ParamEntry[] {
  const keys = Object.keys(params).sort((a, b) => {
    const ra = PARAM_ORDER.indexOf(a);
    const rb = PARAM_ORDER.indexOf(b);
    if (ra !== -1 || rb !== -1) {
      if (ra === -1) return 1;
      if (rb === -1) return -1;
      return ra - rb;
    }
    return a.localeCompare(b);
  });
  return keys.map((key) => ({
    key,
    label: paramLabel(key),
    value: formatParamValue(key, params[key]),
  }));
}

// ---------------------------------------------------------------------------
// Pending suggestions
// ---------------------------------------------------------------------------

/**
 * The calendar date of a suggestion's `trade_date`. The API serialises the DATE column as a
 * timestamp at server-local (IST) midnight, so '2026-05-29' arrives as
 * '2026-05-28T18:30:00.000Z'; slicing that would be a day early. Adding the IST offset back
 * recovers the stored date, which is what the apply endpoint matches. A bare 'YYYY-MM-DD'
 * passes through.
 */
export function suggestionTradeDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ms = new Date(raw).getTime();
  if (Number.isNaN(ms)) return raw.slice(0, 10);
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The keys POST /retrospection/evolution/apply actually writes; others are display-only. */
export const APPLIED_SUGGESTION_KEYS: readonly string[] = ['min_probability'];

export interface SuggestionChange {
  key: string;
  label: string;
  current: string;
  proposed: string;
  /** Proposed − current for two numbers: percentage points for probabilities. */
  delta: number | null;
  deltaUnit: 'pp' | 'number' | null;
  /** False when Approve does not write this key (the server applies min_probability only). */
  applied: boolean;
}

/** Current → Proposed for every proposed key, with the current value from the personality. */
export function suggestionChanges(
  proposed: Readonly<Record<string, unknown>> | null,
  currentParams: Readonly<Record<string, unknown>> | null,
): SuggestionChange[] {
  if (!proposed) return [];
  return Object.entries(proposed).map(([key, next]) => {
    const prev = currentParams ? currentParams[key] : undefined;
    const both =
      typeof prev === 'number' &&
      typeof next === 'number' &&
      Number.isFinite(prev) &&
      Number.isFinite(next);
    const probability = isProbabilityKey(key);
    return {
      key,
      label: paramLabel(key),
      current: currentParams ? formatParamValue(key, prev) : EMPTY,
      proposed: formatParamValue(key, next),
      delta: both ? (probability ? (next - prev) * 100 : next - prev) : null,
      deltaUnit: both ? (probability ? 'pp' : 'number') : null,
      applied: APPLIED_SUGGESTION_KEYS.includes(key),
    };
  });
}

export interface SuggestionEvidence {
  tradeDate: string;
  trades: number | null;
  winRate: number | null;
  /** total_pnl_pct, in percent units. */
  pnlPct: number | null;
  /** beat_clockwork_delta, in percentage points. */
  beatClockwork: number | null;
}

export function suggestionEvidence(s: PendingSuggestion): SuggestionEvidence {
  const trades = toNumberOrNull(s.total_trades);
  const wins = toNumberOrNull(s.winning_trades);
  return {
    tradeDate: suggestionTradeDate(s.trade_date),
    trades,
    winRate: trades !== null && trades > 0 && wins !== null ? wins / trades : null,
    pnlPct: toNumberOrNull(s.total_pnl_pct),
    beatClockwork: toNumberOrNull(s.beat_clockwork_delta),
  };
}

// ---------------------------------------------------------------------------
// Edit dialog validation
// ---------------------------------------------------------------------------

/** Stop-loss bounds, in % of the straddle premium at entry. */
export const STOP_LOSS_MIN_PCT = 0;
export const STOP_LOSS_MAX_PCT = 100;

/** Which key holds a personality's stop-loss: an existing `sl_pct` or `stop_loss_pct`. */
export function stopLossKey(params: Readonly<Record<string, unknown>>): 'sl_pct' | 'stop_loss_pct' {
  if ('sl_pct' in params) return 'sl_pct';
  if ('stop_loss_pct' in params) return 'stop_loss_pct';
  return 'sl_pct';
}

/** A stored number as the text an input starts with (fractions shown as percent). */
export function draftFromParam(value: unknown, asPercent: boolean): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  // Rounding keeps 0.7 × 100 from showing as 70.00000000000001.
  const shown = asPercent ? Math.round(value * 100 * 1e6) / 1e6 : value;
  return formatNumber(shown, 6, { trim: true }).replace(/,/g, '');
}

export interface EditDraft {
  /** Minimum probability as typed, in percent. */
  minProbabilityPct: string;
  /** Stop-loss as typed, in % of the straddle. */
  stopLossPct: string;
}

export interface EditValidation {
  /** Parsed values; a key is absent when its field is left empty (and that is allowed). */
  values: { minProbability?: number; stopLossPct?: number };
  errors: { minProbability?: string; stopLoss?: string };
  valid: boolean;
}

function parseField(
  text: string,
  required: boolean,
  min: number,
  max: number,
  minExclusive: boolean,
  rangeMessage: string,
): { value?: number; error?: string } {
  const trimmed = text.trim();
  if (trimmed === '') return required ? { error: 'Enter a value.' } : {};
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { error: 'Enter a number.' };
  if ((minExclusive ? value <= min : value < min) || value > max) return { error: rangeMessage };
  return { value };
}

/**
 * Validate the edit form. A field may be left empty only when the personality did not have
 * that parameter to begin with (so saving never invents one).
 */
export function validateEdit(
  draft: EditDraft,
  required: { minProbability: boolean; stopLoss: boolean },
): EditValidation {
  const prob = parseField(
    draft.minProbabilityPct,
    required.minProbability,
    0,
    100,
    false,
    'Must be between 0% and 100%.',
  );
  const sl = parseField(
    draft.stopLossPct,
    required.stopLoss,
    STOP_LOSS_MIN_PCT,
    STOP_LOSS_MAX_PCT,
    true,
    `Must be more than ${STOP_LOSS_MIN_PCT}% and at most ${STOP_LOSS_MAX_PCT}% of the straddle.`,
  );
  const values: EditValidation['values'] = {};
  if (prob.value !== undefined) values.minProbability = Math.round(prob.value * 1e4) / 1e6;
  if (sl.value !== undefined) values.stopLossPct = sl.value;
  const errors: EditValidation['errors'] = {};
  if (prob.error) errors.minProbability = prob.error;
  if (sl.error) errors.stopLoss = sl.error;
  return { values, errors, valid: !prob.error && !sl.error };
}

/** The params to PUT: the personality's params with the edited keys replaced. */
export function editedParams(
  params: Readonly<Record<string, unknown>>,
  values: EditValidation['values'],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (values.minProbability !== undefined) next.min_probability = values.minProbability;
  if (values.stopLossPct !== undefined) next[stopLossKey(params)] = values.stopLossPct;
  return next;
}

/** True when the edit changes at least one stored value. */
export function editChangesParams(
  params: Readonly<Record<string, unknown>>,
  values: EditValidation['values'],
): boolean {
  const differs = (stored: unknown, next: number | undefined) =>
    next !== undefined && !(typeof stored === 'number' && Math.abs(stored - next) < 1e-9);
  return (
    differs(params.min_probability, values.minProbability) ||
    differs(params[stopLossKey(params)], values.stopLossPct)
  );
}

// ---------------------------------------------------------------------------
// Server error codes → plain words
// ---------------------------------------------------------------------------

const SERVER_ERRORS: Readonly<Record<string, string>> = {
  FROZEN_VIOLATION: 'This personality is frozen, so its parameters cannot change.',
  COMPARISON_INTEGRITY_VIOLATION:
    'Precision, Adjuster and Reducer would be more than 8 pp apart on minimum probability.',
  EMPTY_UPDATE: 'There was nothing to save.',
  NOT_FOUND: 'This personality no longer exists.',
  personality_not_found: 'This personality no longer exists.',
  no_pending_adjustment: 'This suggestion was already applied or no longer exists.',
  already_applied: 'This suggestion was already applied.',
  invalid_proposed_value: 'The proposed value is not a valid number.',
  invalid_trade_date: 'The suggestion has an invalid trade date.',
  'Not Found': 'The trading server does not offer this action.',
};

/** The API's error code (what lib/api.ts surfaces) as a sentence; unknown text passes through. */
export function serverErrorMessage(error: string): string {
  return SERVER_ERRORS[error] ?? error;
}

// ---------------------------------------------------------------------------
// Comparison integrity (client-side warning; the server is the authority)
// ---------------------------------------------------------------------------

/** Max spread of min_probability across the compared personalities, in percentage points. */
export const INTEGRITY_MAX_SPREAD_PP = 8;

export interface IntegrityMember {
  id: string;
  name: string;
  minProbability: number;
  edited: boolean;
}

export interface IntegrityCheck {
  /** The personalities compared (active, momentum_exhaustion, with a numeric min_probability). */
  members: IntegrityMember[];
  /** max − min, in percentage points. */
  spreadPp: number;
  ok: boolean;
}

/**
 * Mirrors the server's PUT check: the active `momentum_exhaustion` personalities (Precision,
 * Adjuster, Reducer) must keep min_probability within 8 pp of each other, using the proposed
 * value for the one being edited. Returns null when the edit is not part of that comparison
 * (another entry type, inactive, or no proposed min_probability) or there is nobody to compare.
 */
export function checkComparisonIntegrity(
  personalities: readonly Personality[],
  editedId: string,
  proposedMinProbability: number | undefined,
): IntegrityCheck | null {
  const edited = personalities.find((p) => p.id === editedId);
  if (
    !edited ||
    proposedMinProbability === undefined ||
    edited.entry_type !== 'momentum_exhaustion' ||
    !edited.is_active
  ) {
    return null;
  }
  const members: IntegrityMember[] = [];
  for (const p of personalities) {
    if (p.entry_type !== 'momentum_exhaustion' || !p.is_active) continue;
    const isEdited = p.id === editedId;
    const prob = isEdited ? proposedMinProbability : p.params.min_probability;
    if (typeof prob !== 'number' || !Number.isFinite(prob)) continue;
    members.push({ id: p.id, name: p.display_name, minProbability: prob, edited: isEdited });
  }
  if (members.length < 2) return null;
  const probs = members.map((m) => m.minProbability);
  // Rounded so 0.78 − 0.70 reads as exactly 8 pp rather than 8.000000000000007.
  const spreadPp = Math.round((Math.max(...probs) - Math.min(...probs)) * 100 * 1e6) / 1e6;
  return { members, spreadPp, ok: spreadPp <= INTEGRITY_MAX_SPREAD_PP };
}
