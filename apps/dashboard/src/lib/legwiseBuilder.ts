/**
 * Pure helpers for the Options Lab strategy builder: defaults and templates, the one-line leg
 * summary, unique leg ids, the dirty comparison, the mapping from the Python validator's
 * messages to form fields, and the small result figures the run rail shows.
 *
 * No React and no DOM, so everything here is unit-tested under the node vitest env. The Python
 * schema (legwise/schema.py) stays the validator; nothing here decides what is valid.
 */

import type {
  DayRow,
  Leg,
  LegwiseStrategy,
  ReEntry,
  SavedStrategy,
  Underlying,
} from '../types/legwise';
import { formatInt, formatNumber } from './format';

export const UNDERLYINGS: readonly Underlying[] = [
  'NIFTY',
  'BANKNIFTY',
  'MIDCPNIFTY',
  'FINNIFTY',
  'SENSEX',
];

export const STRIKE_TYPES = [
  'ITM3',
  'ITM2',
  'ITM1',
  'ATM',
  'OTM1',
  'OTM2',
  'OTM3',
  'OTM4',
  'OTM5',
  'OTM6',
  'OTM7',
  'OTM8',
  'OTM9',
  'OTM10',
] as const;

/** What the API accepts as a file name (legwise_routes.py `_NAME_RE`). */
export const STRATEGY_NAME_RE = /^[a-z0-9_]{1,64}$/;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function newLeg(id: string, optionType: Leg['option_type'] = 'CE'): Leg {
  return {
    id,
    lots: 1,
    position: 'sell',
    option_type: optionType,
    expiry: 'weekly',
    strike: { strike_type: 'ATM' },
    stop_loss: { percent: 25 },
  };
}

export function newStrategy(underlying: Underlying = 'NIFTY'): LegwiseStrategy {
  return {
    id: 'my_strategy',
    underlying,
    entry_time: '09:20',
    exit_time: '15:15',
    square_off: 'partial',
    legs: [newLeg('leg1', 'CE'), newLeg('leg2', 'PE')],
    overall: {},
    execution: { slippage_pct: 0, cost_per_order_inr: 0 },
  };
}

/** A saved strategy as the form holds it: every section the form edits is present. */
export function fromSaved(strategy: LegwiseStrategy): LegwiseStrategy {
  const base = newStrategy();
  return {
    ...base,
    ...strategy,
    overall: strategy.overall ?? {},
    execution: { ...base.execution, ...(strategy.execution ?? {}) },
  };
}

/**
 * The JSON sent to the API: undefined keys dropped (the Python schema forbids nulls for
 * optionals) and an empty "No re-entry after" treated as unset.
 */
export function toPayload(strategy: LegwiseStrategy): LegwiseStrategy {
  return JSON.parse(
    JSON.stringify({ ...strategy, no_reentry_after: strategy.no_reentry_after || undefined }),
  ) as LegwiseStrategy;
}

// ---------------------------------------------------------------------------
// Dirty comparison
// ---------------------------------------------------------------------------

/** The value with keys sorted at every depth and unset/null keys dropped, so equal strategies read equal. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined && v !== null) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/** Deep equality of two strategies as the API would see them (key order and unset keys ignored). */
export function strategiesEqual(a: LegwiseStrategy, b: LegwiseStrategy): boolean {
  return (
    JSON.stringify(canonical(toPayload(fromSaved(a)))) ===
    JSON.stringify(canonical(toPayload(fromSaved(b))))
  );
}

/** True when the form differs from the version it started from (the loaded or the blank one). */
export function isDirty(
  current: { name: string; strategy: LegwiseStrategy },
  baseline: { name: string; strategy: LegwiseStrategy },
): boolean {
  return current.name !== baseline.name || !strategiesEqual(current.strategy, baseline.strategy);
}

// ---------------------------------------------------------------------------
// Leg ids
// ---------------------------------------------------------------------------

/**
 * The next free id in the `legN` style. With a `source` id (copying a leg) the copy keeps its
 * stem: `leg1` → the next free `legN`, `ce` → `ce2`.
 */
export function nextLegId(existing: readonly string[], source?: string): string {
  const taken = new Set(existing);
  const stem = source?.replace(/\d+$/, '') || 'leg';
  for (let n = taken.has(stem) ? 2 : 1; ; n++) {
    const candidate = `${stem}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// One-line leg summary
// ---------------------------------------------------------------------------

const EXPIRY_LABEL: Record<Leg['expiry'], string> = {
  weekly: 'weekly',
  next_weekly: 'next weekly',
  monthly: 'monthly',
};

function num(value: number): string {
  return formatNumber(value, 2, { trim: true });
}

function amountText(amount: { points?: number | undefined; percent?: number | undefined }): string {
  if (amount.points !== undefined) return `${num(amount.points)} pts`;
  if (amount.percent !== undefined) return `${num(amount.percent)}%`;
  return '';
}

function reentryText(reentry: ReEntry): string {
  const how = reentry.mode === 'cost' ? 'at cost' : 'ASAP';
  return reentry.count > 1 ? `${how} ×${formatInt(reentry.count)}` : how;
}

/** "SELL 1× NIFTY weekly ATM CE · SL 25% · re-entry at cost" */
export function summarizeLeg(leg: Leg, underlying: string): string {
  const strike =
    leg.strike.closest_premium !== undefined
      ? `premium ≈ ${num(leg.strike.closest_premium)}`
      : (leg.strike.strike_type ?? 'ATM');
  const parts = [
    `${leg.position.toUpperCase()} ${formatInt(leg.lots)}× ${underlying} ${EXPIRY_LABEL[leg.expiry]} ${strike} ${leg.option_type}`,
  ];
  if (leg.stop_loss) parts.push(`SL ${amountText(leg.stop_loss)}`);
  if (leg.target) parts.push(`target ${amountText(leg.target)}`);
  const trail = leg.trail_sl?.points ?? leg.trail_sl?.percent;
  if (trail) {
    const unit = leg.trail_sl?.points ? ' pts' : '%';
    parts.push(`trail ${num(trail[0])}/${num(trail[1])}${unit}`);
  }
  if (leg.reentry_on_sl) parts.push(`re-entry ${reentryText(leg.reentry_on_sl)}`);
  if (leg.reentry_on_target) parts.push(`re-entry on target ${reentryText(leg.reentry_on_target)}`);
  if (leg.range_breakout) {
    const on = leg.range_breakout.source === 'underlying' ? 'index' : 'premium';
    const { gap_percent: gap, valid_until: validUntil } = leg.range_breakout;
    const extras = [
      gap ? `${num(gap)}% beyond the range` : '',
      validUntil ? `valid until ${validUntil}` : '',
    ].filter(Boolean);
    parts.push(
      `enters on ${on} ${leg.range_breakout.side} break after ${leg.range_breakout.until}${
        extras.length ? ` (${extras.join(', ')})` : ''
      }`,
    );
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type TemplateId = 'short_strangle' | 'buy_range_breakout' | 'short_strangle_premium';

export interface TemplateInfo {
  id: TemplateId;
  label: string;
  /** One line saying what it trades, in the words the card shows. */
  description: string;
  /** True when the template needs a premium (rupees) from the person starting it. */
  needsPremium: boolean;
}

/**
 * Three starting points, each modelled on a strategy the owner runs every evening
 * (strategies/legwise/nifty_widesl_917_otm1, nifty_buy_range_breakout and
 * nifty_widesl_917_closest_premium). They are written out here, not read from those files, so
 * editing a live strategy never changes a template.
 */
export const TEMPLATES: readonly TemplateInfo[] = [
  {
    id: 'short_strangle',
    label: 'Short strangle',
    description:
      'Sell the call and put one strike out of the money at 09:17. Each leg stops at 115% and trails; everything closes at a ₹2,500 loss or 15:28.',
    needsPremium: false,
  },
  {
    id: 'buy_range_breakout',
    label: 'Buy range breakout',
    description:
      'Buy the call and put priced near ₹50 when one breaks its own 09:35 to 09:45 high. Each leg stops at 25% and trails; ₹2,000 overall loss, out at 15:14.',
    needsPremium: false,
  },
  {
    id: 'short_strangle_premium',
    label: 'Short strangle at a premium',
    description:
      'Sell the call and put whose premium is closest to a price you choose, at 09:17. Each leg stops at 115% and trails; ₹2,500 overall loss, out at 15:25.',
    needsPremium: true,
  },
];

/** The premium the third template opens with, per index. Other indexes must be told one. */
export const DEFAULT_TEMPLATE_PREMIUM: Readonly<Partial<Record<Underlying, number>>> = {
  NIFTY: 65,
};

export function templateInfo(id: TemplateId): TemplateInfo {
  return TEMPLATES.find((t) => t.id === id) ?? (TEMPLATES[0] as TemplateInfo);
}

function templateLeg(
  id: string,
  position: Leg['position'],
  optionType: Leg['option_type'],
  strike: Leg['strike'],
  extra: Partial<Leg> = {},
): Leg {
  return { id, lots: 1, position, option_type: optionType, expiry: 'weekly', strike, ...extra };
}

/**
 * A valid starting strategy for `underlying`, using only what the form can edit. `premium`
 * (rupees) is read by `short_strangle_premium` only; without one it falls back to the index's
 * default, then 65.
 */
export function buildTemplate(
  id: TemplateId,
  underlying: Underlying,
  options: { premium?: number } = {},
): LegwiseStrategy {
  const base = newStrategy(underlying);
  const prefix = underlying.toLowerCase();
  if (id === 'buy_range_breakout') {
    const leg = (legId: string, type: Leg['option_type']): Leg =>
      templateLeg(
        legId,
        'buy',
        type,
        { closest_premium: 50 },
        {
          stop_loss: { percent: 25 },
          trail_sl: { points: [1, 1] },
          range_breakout: { until: '09:45', side: 'high', source: 'instrument' },
        },
      );
    return {
      ...base,
      id: `${prefix}_buy_range_breakout`,
      entry_time: '09:35',
      exit_time: '15:14',
      legs: [leg('ce', 'CE'), leg('pe', 'PE')],
      overall: { stop_loss_inr: 2000 },
    };
  }
  if (id === 'short_strangle_premium') {
    const premium = options.premium ?? DEFAULT_TEMPLATE_PREMIUM[underlying] ?? 65;
    const leg = (legId: string, type: Leg['option_type']): Leg =>
      templateLeg(
        legId,
        'sell',
        type,
        { closest_premium: premium },
        {
          stop_loss: { percent: 115 },
          trail_sl: { points: [15, 10] },
        },
      );
    return {
      ...base,
      id: `${prefix}_short_strangle_premium_${premium}`,
      entry_time: '09:17',
      exit_time: '15:25',
      legs: [leg('ce', 'CE'), leg('pe', 'PE')],
      overall: { stop_loss_inr: 2500 },
    };
  }
  const leg = (legId: string, type: Leg['option_type']): Leg =>
    templateLeg(
      legId,
      'sell',
      type,
      { strike_type: 'OTM1' },
      {
        stop_loss: { percent: 115 },
        trail_sl: { percent: [15, 10] },
      },
    );
  return {
    ...base,
    id: `${prefix}_short_strangle`,
    entry_time: '09:17',
    exit_time: '15:28',
    legs: [leg('ce', 'CE'), leg('pe', 'PE')],
    overall: { stop_loss_inr: 2500 },
  };
}

// ---------------------------------------------------------------------------
// Starting a strategy (the "Start a strategy" dialog)
// ---------------------------------------------------------------------------

/** What the person chose in the Start a strategy dialog. */
export type StartSpec =
  | { kind: 'blank'; underlying: Underlying }
  | { kind: 'template'; id: TemplateId; underlying: Underlying; premium?: number | undefined }
  | { kind: 'copy'; name: string };

/** The name a copy is saved under: `<name>_copy`, then `_copy2`, `_copy3`…, none already taken. */
export function copyName(base: string, taken: ReadonlySet<string>): string {
  const room = 64 - '_copy999'.length;
  const stem = base.slice(0, room);
  let candidate = `${stem}_copy`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem}_copy${n}`;
  return candidate;
}

/** The address query that starts a strategy in the Builder (`?new=…` or `?copy=…`). */
export function startToParams(spec: StartSpec): URLSearchParams {
  const q = new URLSearchParams();
  if (spec.kind === 'copy') {
    q.set('copy', spec.name);
  } else if (spec.kind === 'blank') {
    q.set('new', 'blank');
    q.set('index', spec.underlying);
  } else {
    q.set('new', spec.id);
    q.set('index', spec.underlying);
    if (spec.premium !== undefined) q.set('premium', String(spec.premium));
  }
  return q;
}

/** The inverse of `startToParams`; null when the query names no (valid) start. */
export function startFromParams(q: URLSearchParams): StartSpec | null {
  const copy = q.get('copy');
  if (copy) return { kind: 'copy', name: copy };
  const wanted = q.get('new');
  if (!wanted) return null;
  const index = q.get('index');
  const underlying = UNDERLYINGS.find((u) => u === index) ?? 'NIFTY';
  if (wanted === 'blank') return { kind: 'blank', underlying };
  const template = TEMPLATES.find((t) => t.id === wanted);
  if (!template) return null;
  const premium = Number(q.get('premium'));
  return {
    kind: 'template',
    id: template.id,
    underlying,
    ...(Number.isFinite(premium) && premium > 0 ? { premium } : {}),
  };
}

/**
 * The strategy a start spec opens with, or null (a copy of a strategy that is not saved).
 * Nothing is written: the Builder holds it unsaved until the person presses Save.
 */
export function strategyFromStart(
  spec: StartSpec,
  saved: readonly SavedStrategy[],
): { name: string; strategy: LegwiseStrategy } | null {
  if (spec.kind === 'blank') {
    const strategy = newStrategy(spec.underlying);
    return { name: strategy.id, strategy };
  }
  if (spec.kind === 'template') {
    const strategy = buildTemplate(spec.id, spec.underlying, {
      ...(spec.premium !== undefined ? { premium: spec.premium } : {}),
    });
    return { name: strategy.id, strategy };
  }
  const source = saved.find((s) => s.name === spec.name);
  if (!source) return null;
  const taken = new Set(saved.flatMap((s) => [s.name, s.strategy.id]));
  const name = copyName(source.name, taken);
  return { name, strategy: { ...fromSaved(source.strategy), id: name } };
}

// ---------------------------------------------------------------------------
// Validation messages → fields
// ---------------------------------------------------------------------------

export interface FieldIssue {
  /** The path as the API gave it ("legs.1.stop_loss.percent", "strategy"). */
  path: string;
  /**
   * The form field it belongs to: a top-level key ("exit_time", "overall.stop_loss_inr"), a leg
   * field ("legs.1.stop_loss"), a whole leg ("legs.1"), or null when it cannot be placed.
   */
  slot: string | null;
  legIndex: number | null;
  /** A plain sentence where one is known, else the API's message. */
  message: string;
  raw: string;
}

const LEG_FIELDS = new Set([
  'id',
  'lots',
  'position',
  'option_type',
  'expiry',
  'strike',
  'stop_loss',
  'target',
  'trail_sl',
  'reentry_on_sl',
  'reentry_on_target',
  'range_breakout',
]);

const TOP_FIELDS = new Set([
  'id',
  'underlying',
  'entry_time',
  'exit_time',
  'no_reentry_after',
  'square_off',
  'legs',
]);

const NESTED_FIELDS = new Set([
  'overall.stop_loss_inr',
  'overall.target_inr',
  'execution.slippage_pct',
  'execution.cost_per_order_inr',
]);

const PLAIN: readonly [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^Input should be greater than or equal to (\S+)$/, (m) => `Must be ${m[1]} or more`],
  [/^Input should be less than or equal to (\S+)$/, (m) => `Must be ${m[1]} or less`],
  [/^Input should be greater than (\S+)$/, (m) => `Must be greater than ${m[1]}`],
  [/^Input should be less than (\S+)$/, (m) => `Must be less than ${m[1]}`],
  [/^Field required$/, () => 'Required'],
  [/^Input should be a valid integer/, () => 'Must be a whole number'],
  [/^Input should be a valid number/, () => 'Must be a number'],
  [/^Input should be a valid string/, () => 'Required'],
  [/^Extra inputs are not permitted$/, () => 'This setting is not supported by the engine'],
  [/^List should have at least 1 item/, () => 'Add at least one leg'],
  [/^Input should be (.+)$/, (m) => `Must be one of ${m[1]}`],
  [/is outside the 09:15-15:29 session$/, () => 'Time must be within the 09:15–15:29 session'],
  [/^Invalid isoformat string/, () => 'Enter a time as HH:MM'],
  [/^exit_time must be after entry_time$/, () => 'Exit must be after entry'],
  [/^leg ids must be unique/, () => 'Two legs share an id; give each leg its own id'],
  [/trail_sl needs a stop_loss to trail$/, () => 'Trail SL needs a stop loss to trail'],
  [/reentry_on_sl needs a stop_loss$/, () => 'Re-entry on SL needs a stop loss'],
  [/reentry_on_target needs a target$/, () => 'Re-entry on target needs a target'],
  [
    /range_breakout\.until must be inside entry-exit$/,
    () => 'Range end must be between the entry and exit times',
  ],
  [
    /range_breakout\.valid_until must be after until and no later than exit$/,
    () => 'Range breakout "valid until" must be after the range end and not after the exit time',
  ],
  [
    /^re-entry with square_off: complete is not supported yet$/,
    () => 'Re-entry cannot be combined with Complete square-off yet',
  ],
  [/^strike needs exactly one of/, () => 'Choose a strike type or a premium'],
  [/^strike_type .* expected ATM, OTMn or ITMn$/, () => 'Strike must be ATM, OTMn or ITMn'],
  [/^give exactly one of points or percent$/, () => 'Enter a value in points or percent'],
  [/^trail_sl values must be positive$/, () => 'Both trail values must be greater than 0'],
  [/^trail_sl needs exactly one of/, () => 'Enter the trail in points or percent'],
];

/** The validator's message as a plain sentence, or the message itself when none is known. */
export function plainMessage(message: string): string {
  const text = message.replace(/^Value error, /, '').trim();
  for (const [pattern, render] of PLAIN) {
    const match = text.match(pattern);
    if (match) return render(match);
  }
  return text;
}

function legIndexById(strategy: Pick<LegwiseStrategy, 'legs'>, text: string): number | null {
  const match = text.match(/^leg '([^']*)':/);
  if (!match) return null;
  const index = strategy.legs.findIndex((leg) => leg.id === match[1]);
  return index >= 0 ? index : null;
}

/** Which leg field a leg-level ("legs.N: …") or strategy-level message is really about. */
function fieldFromMessage(text: string): string | null {
  if (/trail_sl needs/.test(text)) return 'trail_sl';
  if (/reentry_on_sl needs/.test(text)) return 'reentry_on_sl';
  if (/reentry_on_target needs/.test(text)) return 'reentry_on_target';
  if (/range_breakout/.test(text)) return 'range_breakout';
  return null;
}

/** One line of the validate endpoint's `errors` ("path: message") placed on the form. */
export function parseIssue(line: string, strategy: Pick<LegwiseStrategy, 'legs'>): FieldIssue {
  const split = line.indexOf(': ');
  const hasPath = split > 0 && /^[A-Za-z0-9_.]+$/.test(line.slice(0, split));
  const path = hasPath ? line.slice(0, split) : 'strategy';
  const raw = hasPath ? line.slice(split + 2) : line;
  const text = raw.replace(/^Value error, /, '');
  const message = plainMessage(raw);
  const parts = path.split('.');

  if (parts[0] === 'legs' && parts[1] !== undefined && /^\d+$/.test(parts[1])) {
    const legIndex = Number(parts[1]);
    const field = parts[2] !== undefined && LEG_FIELDS.has(parts[2]) ? parts[2] : null;
    const resolved = field ?? (parts.length === 2 ? fieldFromMessage(text) : null);
    return {
      path,
      slot: resolved ? `legs.${legIndex}.${resolved}` : `legs.${legIndex}`,
      legIndex,
      message,
      raw,
    };
  }

  if (path === 'strategy') {
    const legIndex = legIndexById(strategy, text);
    if (legIndex !== null) {
      const field = fieldFromMessage(text);
      return {
        path,
        slot: field ? `legs.${legIndex}.${field}` : `legs.${legIndex}`,
        legIndex,
        message,
        raw,
      };
    }
    if (/^exit_time must be after/.test(text))
      return { path, slot: 'exit_time', legIndex: null, message, raw };
    if (/^re-entry with square_off/.test(text))
      return { path, slot: 'square_off', legIndex: null, message, raw };
    return { path, slot: null, legIndex: null, message, raw };
  }

  const two = parts.slice(0, 2).join('.');
  if (NESTED_FIELDS.has(two)) return { path, slot: two, legIndex: null, message, raw };
  if (parts[0] !== undefined && TOP_FIELDS.has(parts[0]))
    return { path, slot: parts[0], legIndex: null, message, raw };
  return { path, slot: null, legIndex: null, message, raw };
}

export interface PlacedIssues {
  /** Messages by form slot; a field shows `bySlot[slot]` beside itself. */
  bySlot: Record<string, string[]>;
  /** How many problems sit inside each leg (for the collapsed card's badge). */
  byLeg: Record<number, number>;
  /** Problems with no field to sit beside; the run rail lists these. */
  unplaced: FieldIssue[];
  count: number;
}

/**
 * Places every validator message on the form. A leg-level problem with no field of its own
 * stays on the leg ("legs.N"); a strategy-level one with no field goes to `unplaced`.
 */
export function placeIssues(
  errors: readonly string[],
  strategy: Pick<LegwiseStrategy, 'legs'>,
): PlacedIssues {
  const placed: PlacedIssues = { bySlot: {}, byLeg: {}, unplaced: [], count: errors.length };
  for (const line of errors) {
    const issue = parseIssue(line, strategy);
    if (issue.legIndex !== null)
      placed.byLeg[issue.legIndex] = (placed.byLeg[issue.legIndex] ?? 0) + 1;
    // "legs" (e.g. an empty list) has no input of its own, so it is listed in the rail.
    if (issue.slot === null || issue.slot === 'legs') placed.unplaced.push(issue);
    else {
      const list = placed.bySlot[issue.slot] ?? [];
      list.push(issue.message);
      placed.bySlot[issue.slot] = list;
    }
  }
  return placed;
}

// ---------------------------------------------------------------------------
// Run rail figures
// ---------------------------------------------------------------------------

/** "Backtest · 1 credit · 12 left" while billing is on; plain "Backtest" otherwise. */
export function backtestLabel(payment: { enabled: boolean; balance: number | null }): string {
  if (!payment.enabled) return 'Backtest';
  if (payment.balance === null) return 'Backtest · 1 credit';
  return `Backtest · 1 credit · ${formatInt(payment.balance)} left`;
}

export type RunFailure = 'credits' | 'access' | 'other';

/** Why the proxy refused a run: 402 = out of credits, 403 = no active access pass. */
export function runFailureKind(status: number | undefined, error: string): RunFailure {
  if (status === 402 || error === 'insufficient_credits') return 'credits';
  if (status === 403 || error === 'access_denied') return 'access';
  return 'other';
}

export interface RunTotals {
  days: number;
  /** ₹ per lot, summed over the run's days. */
  gross: number;
  costs: number;
  net: number;
}

export function runTotals(
  days: readonly Pick<DayRow, 'gross' | 'costs' | 'net'>[],
  lots: number,
): RunTotals {
  const divisor = lots > 0 ? lots : 1;
  const totals = { days: days.length, gross: 0, costs: 0, net: 0 };
  for (const day of days) {
    totals.gross += day.gross / divisor;
    totals.costs += day.costs / divisor;
    totals.net += day.net / divisor;
  }
  return totals;
}

/** The first eight characters of a run id: enough to recognise it in a list. */
export function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

export interface Sparkline {
  /** SVG path for the series, in a `width` × `height` box. */
  path: string;
  /** y of the zero line, or null when zero is outside the series' range. */
  zeroY: number | null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A cumulative series as an SVG path. One point draws a flat line; none draws nothing. */
export function sparkline(values: readonly number[], width: number, height: number): Sparkline {
  if (values.length === 0) return { path: '', zeroY: null };
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const pad = 2;
  const y = (v: number) => round1(pad + (1 - (v - min) / span) * (height - 2 * pad));
  const x = (i: number) => (values.length === 1 ? 0 : round1((i / (values.length - 1)) * width));
  const points = values.length === 1 ? [values[0] ?? 0, values[0] ?? 0] : values;
  const path = points
    .map((v, i) => {
      const px = values.length === 1 ? (i === 0 ? 0 : width) : x(i);
      return `${i === 0 ? 'M' : 'L'}${px},${y(v)}`;
    })
    .join(' ');
  return { path, zeroY: y(0) };
}
