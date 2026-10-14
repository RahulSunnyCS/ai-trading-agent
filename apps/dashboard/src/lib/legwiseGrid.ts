/**
 * Pure helpers for the Builder's leg grid (BL-102 Phase 1c): how each cell is written and read
 * back, which two legs are one CE + PE pair edited together, the strategy as plain words, and
 * the name a strategy gets until its owner writes one.
 *
 * No React and no DOM. The Python schema (legwise/schema.py) stays the validator: parsing here
 * only turns what a person typed into the shape the form holds, or says it cannot.
 */

import type { Amount, Leg, LegwiseStrategy, ReEntry, TrailSL, Underlying } from '../types/legwise';
import { formatInr } from './format';

/** A cell's text the way a reader says it; "—" is off. */
export const OFF = '—';

const EXPIRY_WORDS: Record<Leg['expiry'], string> = {
  weekly: 'weekly',
  next_weekly: 'next weekly',
  monthly: 'monthly',
};

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

// ---------------------------------------------------------------------------
// Cells: text <-> value
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function strikeText(strike: Leg['strike']): string {
  if (strike.closest_premium !== undefined) return `₹${num(strike.closest_premium)}`;
  return strike.strike_type ?? 'ATM';
}

const STRIKE_TYPE_RE = /^(ATM|(?:OTM|ITM)(?:[1-9]|10))$/;

/**
 * "ATM", "OTM1", "itm2" or a premium ("₹65", "65", "65p", "premium 65") -> a strike.
 * A bare number is a premium: a strike type is never a number.
 */
export function parseStrike(text: string): Parsed<Leg['strike']> {
  const t = text.trim().toUpperCase().replace(/\s+/g, '');
  if (STRIKE_TYPE_RE.test(t)) return { ok: true, value: { strike_type: t } };
  const premium = /^(?:₹|PREMIUM:?|RS\.?)?(\d+(?:\.\d+)?)P?$/.exec(t);
  if (premium?.[1] !== undefined) {
    const value = Number(premium[1]);
    if (value > 0) return { ok: true, value: { closest_premium: value } };
  }
  return { ok: false, error: 'Use ATM, OTM1 to OTM10, ITM1 to ITM10, or a premium such as ₹65.' };
}

/** A stop or target: "115%", "20 pts"; off is "—". */
export function amountText(amount: Amount | undefined): string {
  if (amount?.percent !== undefined) return `${num(amount.percent)}%`;
  if (amount?.points !== undefined) return `${num(amount.points)} pts`;
  return OFF;
}

/** "115%" -> percent; "20", "20pts", "20 points" -> points; "", "—", "off" -> off (undefined). */
export function parseAmount(text: string): Parsed<Amount | undefined> {
  const t = text.trim().toLowerCase();
  if (t === '' || t === OFF || t === 'off' || t === 'none') return { ok: true, value: undefined };
  const m = /^(\d+(?:\.\d+)?)\s*(%|pts?|points?)?$/.exec(t);
  if (m?.[1] === undefined) {
    return { ok: false, error: 'Use a number with % or pts, for example 25% or 10 pts.' };
  }
  const value = Number(m[1]);
  if (!(value > 0))
    return { ok: false, error: 'It must be above 0. Leave it empty to turn it off.' };
  return { ok: true, value: m[2] === '%' ? { percent: value } : { points: value } };
}

export function trailText(trail: TrailSL | undefined): string {
  if (trail?.percent) return `${num(trail.percent[0])}/${num(trail.percent[1])}%`;
  if (trail?.points) return `${num(trail.points[0])}/${num(trail.points[1])} pts`;
  return OFF;
}

/** "15/10%" -> percent; "1/1", "15/10 pts" -> points; empty -> off. X moves, Y is the step. */
export function parseTrail(text: string): Parsed<TrailSL | undefined> {
  const t = text.trim().toLowerCase();
  if (t === '' || t === OFF || t === 'off' || t === 'none') return { ok: true, value: undefined };
  const m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(%|pts?|points?)?$/.exec(t);
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

export function reentryText(r: ReEntry | undefined): string {
  if (!r) return OFF;
  return `${r.mode === 'asap' ? 'Now' : 'At cost'} ×${r.count}`;
}

/** "now ×2", "asap x1", "cost ×3" -> re-entry; empty -> off. The count is 1 to 20. */
export function parseReentry(text: string): Parsed<ReEntry | undefined> {
  const t = text.trim().toLowerCase();
  if (t === '' || t === OFF || t === 'off' || t === 'none') return { ok: true, value: undefined };
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

/** JSON with keys sorted at every depth, so equal values give equal text. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Every field a pair shares: all of a leg but its id and its option type. */
function pairKey(leg: Leg): string {
  const { id: _id, option_type: _type, ...rest } = leg;
  return stable(rest);
}

/**
 * The index of the leg that `index` is paired with: the one opposite-type leg that matches it
 * in every other field (side, lots, expiry, strike, stop, target, trail, re-entry, breakout).
 * Null when there is none or more than one candidate, so a pair is only ever what is plainly one.
 */
export function pairedWith(legs: readonly Leg[], index: number): number | null {
  const leg = legs[index];
  if (!leg) return null;
  const key = pairKey(leg);
  const matches = legs
    .map((other, i) => ({ other, i }))
    .filter(({ other, i }) => i !== index && other.option_type !== leg.option_type)
    .filter(({ other }) => pairKey(other) === key);
  return matches.length === 1 ? (matches[0]?.i ?? null) : null;
}

/**
 * `patch` applied to a leg and, when `together` is on and the leg has a partner, to the partner
 * too. The partner is found before the patch, so editing the strike of one still moves the other.
 */
export function applyToLegs(
  legs: readonly Leg[],
  index: number,
  patch: Partial<Leg>,
  together: boolean,
): Leg[] {
  const partner = together ? pairedWith(legs, index) : null;
  return legs.map((leg, i) => (i === index || i === partner ? { ...leg, ...patch } : leg));
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

function amountWords(a: Amount): string {
  return a.percent !== undefined ? `${num(a.percent)}%` : `${num(a.points ?? 0)} points`;
}

function legRules(leg: Leg): string[] {
  const out: string[] = [];
  if (leg.stop_loss) out.push(`stops at ${amountWords(leg.stop_loss)}`);
  if (leg.trail_sl) {
    const t = leg.trail_sl.percent ?? leg.trail_sl.points ?? [0, 0];
    const unit = leg.trail_sl.percent ? '%' : ' points';
    out.push(
      `trails: for every ${num(t[0])}${unit} in your favour the stop moves ${num(t[1])}${unit}`,
    );
  }
  if (leg.target) out.push(`takes profit at ${amountWords(leg.target)}`);
  if (leg.reentry_on_sl) {
    out.push(
      `re-enters ${leg.reentry_on_sl.mode === 'asap' ? 'at once' : 'at cost'} up to ${leg.reentry_on_sl.count} time${leg.reentry_on_sl.count === 1 ? '' : 's'} after a stop`,
    );
  }
  if (leg.reentry_on_target) {
    out.push(
      `re-enters ${leg.reentry_on_target.mode === 'asap' ? 'at once' : 'at cost'} up to ${leg.reentry_on_target.count} time${leg.reentry_on_target.count === 1 ? '' : 's'} after its target`,
    );
  }
  if (leg.range_breakout) {
    const on = leg.range_breakout.source === 'underlying' ? 'index' : 'option';
    out.push(
      `enters only when the ${on} breaks the ${leg.range_breakout.side} of its range until ${leg.range_breakout.until}`,
    );
  }
  return out;
}

/** One sentence for a leg, or for a CE + PE pair when `pair` is given. */
function legSentence(leg: Leg, underlying: Underlying, pair: boolean): string {
  const verb = leg.position === 'sell' ? 'sell' : 'buy';
  const lots = `${leg.lots} lot${leg.lots === 1 ? '' : 's'}`;
  const what = pair
    ? `the ${underlying} ${EXPIRY_WORDS[leg.expiry]} call and put`
    : `the ${underlying} ${EXPIRY_WORDS[leg.expiry]} ${leg.option_type === 'CE' ? 'call' : 'put'}`;
  const head = `${verb[0]?.toUpperCase()}${verb.slice(1)} ${lots}${pair ? ' each' : ''} of ${what}, ${strikeWords(leg.strike)}`;
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
  const timing = `Every trading day, enter at ${strategy.entry_time}.`;
  const tail: string[] = [];
  if (strategy.no_reentry_after) tail.push(`No new entry after ${strategy.no_reentry_after}.`);
  tail.push(
    strategy.square_off === 'complete'
      ? 'When one leg stops out, every leg exits.'
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
  const strikes = new Set(legs.map((l) => strikeText(l.strike)));
  const both = new Set(legs.map((l) => l.option_type)).size === 2;
  const one = strikes.size === 1 ? [...strikes][0] : undefined;
  if (allBuy && legs.some((l) => l.range_breakout) && one)
    return `Buy range breakout ${one} · ${time}`;
  if ((allSell || allBuy) && both && one) {
    const shape = one === 'ATM' ? 'straddle' : 'strangle';
    const parts = [allSell ? 'Short' : 'Long', shape, ...(one === 'ATM' ? [] : [one])];
    return `${parts.join(' ')} · ${time}`;
  }
  return `Custom · ${time}`;
}

/** A file-name-safe id from a name: a-z, 0-9 and _, at most 64, led by the index. */
export function slugId(name: string, underlying: Underlying): string {
  const prefix = underlying.toLowerCase();
  const body = name
    .toLowerCase()
    .replace(/₹/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const joined = body.startsWith(`${prefix}_`) || body === prefix ? body : `${prefix}_${body}`;
  return (joined || prefix).slice(0, 64).replace(/_+$/g, '');
}
