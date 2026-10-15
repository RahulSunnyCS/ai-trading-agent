/**
 * Pure helpers for the Builder's leg grid (BL-102 Phase 1c): how each cell is written and read
 * back, which two legs are one CE + PE pair edited together, the strategy as plain words, and
 * the name a strategy gets until its owner writes one.
 *
 * No React and no DOM. The Python schema (legwise/schema.py) stays the validator: parsing here
 * only turns what a person typed into the shape the form holds, or says it cannot. The cell
 * writers are named `*Cell` so they are not confused with the builder's one-line summary
 * helpers (`amountText`, `reentryText` in legwiseBuilder.ts), which word the same values
 * differently on purpose: a cell is short and editable, a summary is read.
 */

import type { Amount, Leg, LegwiseStrategy, ReEntry, TrailSL, Underlying } from '../types/legwise';
import { formatInr } from './format';
import { canonical } from './legwiseBuilder';

/** A cell's text the way a reader says it; "—" is off. */
export const OFF = '—';

const EXPIRY_WORDS: Record<Leg['expiry'], string> = {
  weekly: 'weekly',
  next_weekly: 'next weekly',
  monthly: 'monthly',
};

/** A number as typed: no grouping (a cell must parse back), at most two decimals. */
function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

// ---------------------------------------------------------------------------
// Cells: text <-> value
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function strikeCell(strike: Leg['strike']): string {
  if (strike.closest_premium !== undefined) return `₹${num(strike.closest_premium)}`;
  return strike.strike_type ?? 'ATM';
}

// The schema's strike types: ATM, or OTM/ITM followed by 1 to 99.
const STRIKE_TYPE_RE = /^(ATM|(?:OTM|ITM)[1-9]\d?)$/;

/**
 * "ATM", "OTM1", "itm2" or a premium ("₹65", "65", "65p", "premium 65") -> a strike.
 * A bare number is a premium: a strike type is never a number.
 */
export function parseStrike(text: string): Parsed<Leg['strike']> {
  const t = text.trim().toUpperCase().replace(/\s+/g, '');
  if (STRIKE_TYPE_RE.test(t)) return { ok: true, value: { strike_type: t } };
  const premium = /^(?:₹|PREMIUM:?|RS\.?)?(\d*\.?\d+)P?$/.exec(t);
  if (premium?.[1] !== undefined) {
    const value = Number(premium[1]);
    if (value > 0) return { ok: true, value: { closest_premium: value } };
  }
  return { ok: false, error: 'Use ATM, OTM1, ITM2…, or a premium such as ₹65.' };
}

/** A stop or target: "115%", "20 pts"; off is "—". */
export function amountCell(amount: Amount | undefined): string {
  if (amount?.percent !== undefined) return `${num(amount.percent)}%`;
  if (amount?.points !== undefined) return `${num(amount.points)} pts`;
  return OFF;
}

const OFF_WORDS = new Set(['', OFF, 'off', 'none']);

/** "115%" -> percent; "20", "20pts", "20 points" -> points; "", "—", "off" -> off (undefined). */
export function parseAmount(text: string): Parsed<Amount | undefined> {
  const t = text.trim().toLowerCase();
  if (OFF_WORDS.has(t)) return { ok: true, value: undefined };
  const m = /^(\d*\.?\d+)\s*(%|pts?|points?)?$/.exec(t);
  if (m?.[1] === undefined) {
    return { ok: false, error: 'Use a number with % or pts, for example 25% or 10 pts.' };
  }
  const value = Number(m[1]);
  if (!(value > 0))
    return { ok: false, error: 'It must be above 0. Leave it empty to turn it off.' };
  return { ok: true, value: m[2] === '%' ? { percent: value } : { points: value } };
}

export function trailCell(trail: TrailSL | undefined): string {
  if (trail?.percent) return `${num(trail.percent[0])}/${num(trail.percent[1])}%`;
  if (trail?.points) return `${num(trail.points[0])}/${num(trail.points[1])} pts`;
  return OFF;
}

/** "15/10%" -> percent; "1/1", "15/10 pts" -> points; empty -> off. Every X move the stop by Y. */
export function parseTrail(text: string): Parsed<TrailSL | undefined> {
  const t = text.trim().toLowerCase();
  if (OFF_WORDS.has(t)) return { ok: true, value: undefined };
  const m = /^(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)\s*(%|pts?|points?)?$/.exec(t);
  if (m?.[1] === undefined || m[2] === undefined) {
    return {
      ok: false,
      error: 'Use X/Y, for example 15/10% or 1/1 pts: every X move the stop by Y.',
    };
  }
  const pair: [number, number] = [Number(m[1]), Number(m[2])];
  if (!(pair[0] > 0) || !(pair[1] > 0)) {
    return { ok: false, error: 'Both numbers must be above 0.' };
  }
  return { ok: true, value: m[3] === '%' ? { percent: pair } : { points: pair } };
}

export function reentryCell(r: ReEntry | undefined): string {
  if (!r) return OFF;
  return `${r.mode === 'asap' ? 'Now' : 'At cost'} ×${r.count}`;
}

/** "now ×2", "asap x1", "at cost ×3" -> re-entry; empty -> off. The count is 1 to 20. */
export function parseReentry(text: string): Parsed<ReEntry | undefined> {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (OFF_WORDS.has(t)) return { ok: true, value: undefined };
  const m = /^(now|asap|at cost|cost)\s*[x×]?\s*(\d{1,2})?$/.exec(t);
  if (m?.[1] === undefined) {
    return { ok: false, error: 'Use now ×2 (at once) or at cost ×1, up to 20 times.' };
  }
  const count = m[2] === undefined ? 1 : Number(m[2]);
  if (count < 1 || count > 20) return { ok: false, error: 'The count is 1 to 20.' };
  return { ok: true, value: { mode: m[1] === 'now' || m[1] === 'asap' ? 'asap' : 'cost', count } };
}

// ---------------------------------------------------------------------------
// CE + PE pairs
// ---------------------------------------------------------------------------

/** Every field a pair shares: all of a leg but its id and its option type. */
function pairKey(leg: Leg): string {
  const { id: _id, option_type: _type, ...rest } = leg;
  return JSON.stringify(canonical(rest));
}

/** The one opposite-type leg that matches `index` everywhere else; null if none or several. */
function candidate(legs: readonly Leg[], index: number): number | null {
  const leg = legs[index];
  if (!leg) return null;
  const key = pairKey(leg);
  const found = legs
    .map((other, i) => ({ other, i }))
    .filter(({ other, i }) => i !== index && other.option_type !== leg.option_type)
    .filter(({ other }) => pairKey(other) === key);
  return found.length === 1 ? (found[0]?.i ?? null) : null;
}

/**
 * The index of the leg that `index` is paired with: its one opposite-type look-alike (same side,
 * lots, expiry, strike, stop, target, trail, re-entry and breakout), and only when it picks the
 * leg back. With a spare copy of a leg around, neither is paired, so "edit together" can never
 * reach a leg the person did not mean.
 */
export function pairedWith(legs: readonly Leg[], index: number): number | null {
  const other = candidate(legs, index);
  return other !== null && candidate(legs, other) === index ? other : null;
}

/**
 * `patch` applied to a leg and, when `together` is on and the leg has a partner, to the partner
 * too. The partner is found before the patch, so editing the strike of one still moves the other.
 * A leg's id and option type are its own: they never travel to the partner.
 */
export function applyToLegs(
  legs: readonly Leg[],
  index: number,
  patch: Partial<Leg>,
  together: boolean,
): Leg[] {
  const partner = together ? pairedWith(legs, index) : null;
  const { id: _id, option_type: _type, ...shared } = patch;
  return legs.map((leg, i) => {
    if (i === index) return { ...leg, ...patch };
    if (i === partner) return { ...leg, ...shared };
    return leg;
  });
}

// ---------------------------------------------------------------------------
// The strategy as plain words
// ---------------------------------------------------------------------------

function strikeWords(strike: Leg['strike']): string {
  if (strike.closest_premium !== undefined) {
    return `with the premium closest to ₹${num(strike.closest_premium)}`;
  }
  const t = strike.strike_type ?? 'ATM';
  if (t === 'ATM') return 'at the money';
  const n = Number(t.slice(3));
  const side = t.startsWith('OTM') ? 'out of the money' : 'in the money';
  return `${n === 1 ? 'one strike' : `${n} strikes`} ${side}`;
}

function unitWords(value: number, unit: 'percent' | 'points'): string {
  return unit === 'percent'
    ? `${num(value)}%`
    : `${num(value)} ${value === 1 ? 'point' : 'points'}`;
}

/**
 * A stop or target is a distance from the entry price, not a level: a sold leg stops when its
 * price RISES by it and takes profit when it FALLS; a bought leg is the reverse.
 */
function moveWords(leg: Leg, amount: Amount, kind: 'stop' | 'target'): string {
  const rises = (leg.position === 'sell') === (kind === 'stop');
  const distance =
    amount.percent !== undefined
      ? unitWords(amount.percent, 'percent')
      : unitWords(amount.points ?? 0, 'points');
  const verb = kind === 'stop' ? 'stops out' : 'takes profit';
  return `${verb} if its price ${rises ? 'rises' : 'falls'} ${distance} from the entry price`;
}

function reentryWords(r: ReEntry, after: string): string {
  return `re-enters ${r.mode === 'asap' ? 'at once' : 'at cost'} up to ${r.count} time${r.count === 1 ? '' : 's'} after ${after}`;
}

function legRules(leg: Leg): string[] {
  const out: string[] = [];
  if (leg.stop_loss) out.push(moveWords(leg, leg.stop_loss, 'stop'));
  if (leg.trail_sl) {
    const unit = leg.trail_sl.percent ? 'percent' : 'points';
    const t = leg.trail_sl.percent ?? leg.trail_sl.points ?? [0, 0];
    out.push(
      `trails: for every ${unitWords(t[0], unit)} the price moves in your favour the stop moves ${unitWords(t[1], unit)}`,
    );
  }
  if (leg.target) out.push(moveWords(leg, leg.target, 'target'));
  if (leg.reentry_on_sl) out.push(reentryWords(leg.reentry_on_sl, 'a stop'));
  if (leg.reentry_on_target) out.push(reentryWords(leg.reentry_on_target, 'its target'));
  if (leg.range_breakout) {
    const rb = leg.range_breakout;
    const on = rb.source === 'underlying' ? 'the index' : 'its own price';
    const extras = [
      rb.gap_percent ? `${num(rb.gap_percent)}% beyond the range` : '',
      rb.valid_until ? `only until ${rb.valid_until}` : '',
    ].filter(Boolean);
    out.push(
      `waits: it watches ${on} until ${rb.until}, then enters on the first break of the ${rb.side}${extras.length ? ` (${extras.join(', ')})` : ''}`,
    );
  }
  return out;
}

/** One sentence for a leg, or for a CE + PE pair when `pair` is given. */
function legSentence(leg: Leg, underlying: Underlying, pair: boolean): string {
  const verb = leg.position === 'sell' ? 'Sell' : 'Buy';
  const lots = `${leg.lots} lot${leg.lots === 1 ? '' : 's'}`;
  const what = pair
    ? `the ${underlying} ${EXPIRY_WORDS[leg.expiry]} call and put`
    : `the ${underlying} ${EXPIRY_WORDS[leg.expiry]} ${leg.option_type === 'CE' ? 'call' : 'put'}`;
  const head = `${verb} ${lots}${pair ? ' each' : ''} of ${what}, ${strikeWords(leg.strike)}`;
  const rules = legRules(leg);
  return rules.length
    ? `${head}. ${pair ? 'Each leg' : 'This leg'} ${rules.join('; ')}.`
    : `${head}.`;
}

/** The whole strategy as a few plain sentences: what is traded, when, and what ends it. */
export function readBack(strategy: LegwiseStrategy): string {
  const lines: string[] = [];
  const emitted = new Set<number>();
  const legs = strategy.legs;
  legs.forEach((leg, i) => {
    if (emitted.has(i)) return;
    const partner = pairedWith(legs, i);
    if (partner !== null && !emitted.has(partner) && partner > i) {
      emitted.add(partner);
      lines.push(legSentence(leg, strategy.underlying, true));
    } else {
      lines.push(legSentence(leg, strategy.underlying, false));
    }
    emitted.add(i);
  });
  const waits = legs.some((l) => l.range_breakout);
  const timing = waits
    ? `Every trading day, start at ${strategy.entry_time}; a leg with a breakout rule enters only when it triggers.`
    : `Every trading day, enter at ${strategy.entry_time}.`;
  const tail: string[] = [];
  if (strategy.no_reentry_after) tail.push(`No new entry after ${strategy.no_reentry_after}.`);
  tail.push(
    strategy.square_off === 'complete'
      ? 'When one leg stops out or hits its target, every leg exits.'
      : 'A leg that stops out exits on its own.',
  );
  const { stop_loss_inr: loss, target_inr: profit } = strategy.overall ?? {};
  if (loss !== undefined && profit !== undefined) {
    tail.push(
      `Everything closes at a ${formatInr(loss)} loss or a ${formatInr(profit)} profit, or at ${strategy.exit_time}.`,
    );
  } else if (loss !== undefined) {
    tail.push(`Everything closes at a ${formatInr(loss)} loss, or at ${strategy.exit_time}.`);
  } else if (profit !== undefined) {
    tail.push(`Everything closes at a ${formatInr(profit)} profit, or at ${strategy.exit_time}.`);
  } else {
    tail.push(`Anything still open closes at ${strategy.exit_time}.`);
  }
  return [timing, ...lines, ...tail].join(' ');
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * A name for a strategy from what it does, until its owner writes one: "Short strangle OTM1 ·
 * 09:17", "Buy range breakout ₹50 · 09:35", "Custom · 09:20".
 */
export function autoName(strategy: LegwiseStrategy): string {
  const legs = strategy.legs;
  const time = strategy.entry_time;
  if (legs.length === 0) return `Custom · ${time}`;
  const allSell = legs.every((l) => l.position === 'sell');
  const allBuy = legs.every((l) => l.position === 'buy');
  const strikes = new Set(legs.map((l) => strikeCell(l.strike)));
  const sameExpiry = new Set(legs.map((l) => l.expiry)).size === 1;
  const both = new Set(legs.map((l) => l.option_type)).size === 2;
  const one = strikes.size === 1 ? [...strikes][0] : undefined;
  if (allBuy && legs.every((l) => l.range_breakout) && one) {
    return `Buy range breakout ${one} · ${time}`;
  }
  if ((allSell || allBuy) && both && one && sameExpiry) {
    const shape = one === 'ATM' ? 'straddle' : 'strangle';
    const parts = [allSell ? 'Short' : 'Long', shape, ...(one === 'ATM' ? [] : [one])];
    return `${parts.join(' ')} · ${time}`;
  }
  return `Custom · ${time}`;
}

/**
 * A file-name-safe id from a name: a-z, 0-9 and _, at most 64, led by the index. A name with no
 * a-z or 0-9 at all (another script, only symbols) gets `<index>_strategy`.
 */
export function slugId(name: string, underlying: Underlying): string {
  const prefix = underlying.toLowerCase();
  const body = name
    .toLowerCase()
    .replace(/₹/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const led = body === '' ? `${prefix}_strategy` : body;
  const joined = led === prefix || led.startsWith(`${prefix}_`) ? led : `${prefix}_${led}`;
  return joined.slice(0, 64).replace(/_+$/g, '');
}

// ---------------------------------------------------------------------------
// Backtest period
// ---------------------------------------------------------------------------

export type PeriodKey = '3m' | '1y' | 'all';

export const PERIOD_LABEL: Record<PeriodKey, string> = {
  '3m': '3 months',
  '1y': '1 year',
  all: 'All data',
};

/** Whole calendar months back from a YYYY-MM-DD, clamped to the month's last day. */
function monthsBack(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(Math.min(d, last))}`;
}

/**
 * The from/to a period means, counted back from the last collected day. "All" is both empty
 * (the API's "everything collected"). Strings, so nothing depends on the viewer's time zone.
 */
export function periodRange(lastDay: string | null, key: PeriodKey): { from: string; to: string } {
  if (key === 'all' || lastDay === null) return { from: '', to: '' };
  return { from: monthsBack(lastDay, key === '3m' ? 3 : 12), to: lastDay };
}

/** Which period a from/to pair is, for highlighting its chip; null for a custom range. */
export function periodOf(from: string, to: string, lastDay: string | null): PeriodKey | null {
  if (from === '' && to === '') return 'all';
  for (const key of ['3m', '1y'] as const) {
    const range = periodRange(lastDay, key);
    if (range.from === from && range.to === to && from !== '') return key;
  }
  return null;
}
