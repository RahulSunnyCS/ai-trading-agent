/**
 * The portfolio stop's setting (BL-095): what the owner types, what is sent to the API, and the
 * words that say what it will do. Drafts stay strings so an emptied field stays empty ("nothing
 * typed" is "no portfolio stop", as is 0 or below). Nothing here computes a figure.
 *
 * Trailing is AlgoTest's three modes, written from its wording:
 *   Trail SL      every ₹X of profit, move the stop up ₹Y (needs a stop)
 *   Lock profit   once profit reaches ₹A, lock ₹B
 *   Lock + trail  once profit reaches ₹A, lock ₹B, then every ₹X more, raise it ₹Y
 */

import { formatInr } from './format';

export type TrailMode = 'none' | 'sl' | 'lock' | 'locktrail';

export interface PortfolioStopSetting {
  /** Rupees as typed; empty, 0 or below is no stop. */
  stop: string;
  mode: TrailMode;
  /** Profit that arms a lock. */
  a: string;
  /** The level a lock holds. */
  b: string;
  /** Trail step: every x of profit. */
  x: string;
  /** Trail step: move the stop y. */
  y: string;
}

/** Adaptive Classic's (Core) stop, the owner's level for one lot a strategy (2026-10-19). */
export const DEFAULT_STOP = '8000';
/** Adaptive Tuned's (the T1 track) stop (owner, 2026-10-19). */
export const DEFAULT_T1_STOP = '9000';

export const DEFAULT_SETTING: PortfolioStopSetting = {
  stop: DEFAULT_STOP,
  mode: 'none',
  a: '',
  b: '',
  x: '',
  y: '',
};

export const DEFAULT_T1_SETTING: PortfolioStopSetting = {
  ...DEFAULT_SETTING,
  stop: DEFAULT_T1_STOP,
};

/** Where one card's setting is kept: its URL query keys, its browser storage key, its default. */
export interface PortfolioStopKeys {
  stopParam: string;
  trailParam: string;
  storageKey: string;
  defaults: PortfolioStopSetting;
}

/** Adaptive Classic (Core) and every page widget that follows it. The storage key's version went
 * to v2 with the ₹8,000 default, so a ₹10,000 kept from before does not override it. */
export const CORE_STOP_KEYS: PortfolioStopKeys = {
  stopParam: 'pfstop',
  trailParam: 'pftrail',
  storageKey: 'ata.rotation.portfolioStop.v2',
  defaults: DEFAULT_SETTING,
};

/** Adaptive Tuned (the T1 track's card). */
export const T1_STOP_KEYS: PortfolioStopKeys = {
  stopParam: 'pfstop_t1',
  trailParam: 'pftrail_t1',
  storageKey: 'ata.rotation.portfolioStop.t1.v1',
  defaults: DEFAULT_T1_SETTING,
};

/** The Fixed base card's stop (owner, 2026-10-19): ₹8,000, on 3 lots (2 Widesl + 1 Dir). */
export const DEFAULT_BASE_SETTING: PortfolioStopSetting = { ...DEFAULT_SETTING, stop: '8000' };

/** The Fixed base card. */
export const BASE_STOP_KEYS: PortfolioStopKeys = {
  stopParam: 'pfstop_base',
  trailParam: 'pftrail_base',
  storageKey: 'ata.rotation.portfolioStop.base.v1',
  defaults: DEFAULT_BASE_SETTING,
};

export const MODE_LABEL: Record<TrailMode, string> = {
  none: 'None',
  sl: 'Trail SL',
  lock: 'Lock profit',
  locktrail: 'Lock and trail',
};

export const MODE_FIELDS: Record<TrailMode, readonly ('a' | 'b' | 'x' | 'y')[]> = {
  none: [],
  sl: ['x', 'y'],
  lock: ['a', 'b'],
  locktrail: ['a', 'b', 'x', 'y'],
};

const FIELD_NAME = {
  a: 'the profit that arms the lock',
  b: 'the locked profit',
  x: 'the profit step',
  y: 'the stop move',
} as const;

function num(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function positive(text: string): number | null {
  const v = num(text);
  return v !== null && v > 0 ? v : null;
}

/** The stop in rupees, or null for none (empty, 0 or below, not a number). */
export function amountOf(s: PortfolioStopSetting): number | null {
  return positive(s.stop);
}

/** What stops the setting from being applied; empty when it is fine. */
export function problems(s: PortfolioStopSetting): string[] {
  const out: string[] = [];
  if (s.stop.trim() !== '' && num(s.stop) === null) out.push('Stop loss must be a number.');
  if (s.mode === 'none') return out;
  if (s.mode === 'sl' && amountOf(s) === null) {
    out.push('Trail SL moves the stop, so it needs a stop loss amount.');
  }
  for (const f of MODE_FIELDS[s.mode]) {
    if (positive(s[f]) === null) out.push(`Enter ${FIELD_NAME[f]} as a number above 0.`);
  }
  const [x, y, a, b] = [positive(s.x), positive(s.y), positive(s.a), positive(s.b)];
  if ((s.mode === 'sl' || s.mode === 'locktrail') && x !== null && y !== null && y > x) {
    out.push('The stop cannot move more than the profit did: the move is above the step.');
  }
  if ((s.mode === 'lock' || s.mode === 'locktrail') && a !== null && b !== null && b > a) {
    out.push('The locked profit cannot be above the profit that arms it.');
  }
  return out;
}

/** The `trail` query value, or null for no trailing (or a mode with problems). */
export function trailParam(s: PortfolioStopSetting): string | null {
  if (s.mode === 'none' || problems(s).length > 0) return null;
  const values = MODE_FIELDS[s.mode].map((f) => String(positive(s[f])));
  return `${s.mode}:${values.join(',')}`;
}

/** Whether the setting changes anything: a stop, or a lock that works without one. */
export function isOn(s: PortfolioStopSetting): boolean {
  return amountOf(s) !== null || trailParam(s) !== null;
}

/** The query values for the API; a null is left out of the URL. */
export function queryOf(s: PortfolioStopSetting): { stop: string | null; trail: string | null } {
  const amount = amountOf(s);
  return { stop: amount === null ? null : String(amount), trail: trailParam(s) };
}

const inr = (v: number) => formatInr(v);

/** The words under the pop-up's fields. */
export function summary(s: PortfolioStopSetting): string {
  const amount = amountOf(s);
  const [a, b, x, y] = [positive(s.a), positive(s.b), positive(s.x), positive(s.y)];
  const ready = problems(s).length === 0;
  const floor = amount === null ? '' : ` The stop stays at -${inr(amount)} until then.`;
  if (s.mode === 'none' || !ready) {
    return amount === null
      ? 'No portfolio stop: the figures are the logged ones.'
      : `No trailing: the stop stays at -${inr(amount)}.`;
  }
  if (s.mode === 'sl' && amount !== null && x !== null && y !== null) {
    return `Starts at -${inr(amount)}; after +${inr(x)} it is -${inr(amount - y)}, after +${inr(2 * x)} it is -${inr(amount - 2 * y)}. It never moves down.`;
  }
  if (s.mode === 'lock' && a !== null && b !== null) {
    return `Once profit touches ${inr(a)} the basket closes if it falls back to ${inr(b)}.${floor}`;
  }
  if (s.mode === 'locktrail' && a !== null && b !== null && x !== null && y !== null) {
    return `Once profit touches ${inr(a)} the level is ${inr(b)}, then +${inr(y)} for every further ${inr(x)} of profit.${floor}`;
  }
  return '';
}

const plain = (text: string) => {
  const v = positive(text);
  return v === null ? '' : formatInr(v).replace('₹', '');
};

/** The button's label: the stop and, when set, the trailing. */
export function buttonLabel(s: PortfolioStopSetting): string {
  const amount = amountOf(s);
  const head = amount === null ? 'Portfolio stop off' : `Portfolio stop ${inr(amount)}`;
  if (s.mode === 'none' || problems(s).length > 0) return head;
  const lead = amount === null ? 'Profit lock' : head;
  if (s.mode === 'sl') return `${lead} · trail ${plain(s.x)} → ${plain(s.y)}`;
  if (s.mode === 'lock') return `${lead} · lock ${plain(s.a)} → ${plain(s.b)}`;
  return `${lead} · lock ${plain(s.a)} → ${plain(s.b)}, trail ${plain(s.x)} → ${plain(s.y)}`;
}

/** What was kept in the browser, made safe: anything unreadable is the default. */
export function parseStored(
  raw: unknown,
  defaults: PortfolioStopSetting = DEFAULT_SETTING,
): PortfolioStopSetting {
  if (typeof raw !== 'object' || raw === null) return defaults;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.length <= 12 ? v : '');
  const mode = r.mode;
  if (mode !== 'none' && mode !== 'sl' && mode !== 'lock' && mode !== 'locktrail') {
    return defaults;
  }
  return {
    stop: typeof r.stop === 'string' && r.stop.length <= 12 ? r.stop : defaults.stop,
    mode,
    a: text(r.a),
    b: text(r.b),
    x: text(r.x),
    y: text(r.y),
  };
}

/** Whether two `trail` strings (the API's echo and this page's own) say the same thing. Compared
 * as numbers, so how the server writes 1250000 (`1.25e+06`) cannot matter. */
export function sameTrail(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const [modeA = '', restA = ''] = a.split(':');
  const [modeB = '', restB = ''] = b.split(':');
  if (modeA !== modeB) return false;
  const left = restA.split(',').map(Number);
  const right = restB.split(',').map(Number);
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

function isDefault(s: PortfolioStopSetting, defaults: PortfolioStopSetting): boolean {
  return (
    s.stop === defaults.stop &&
    s.mode === 'none' &&
    s.a === '' &&
    s.b === '' &&
    s.x === '' &&
    s.y === ''
  );
}

/** The setting as URL query values (`pfstop`, `pftrail`; a card with other keys maps these to
 * its own), or nulls when it is that card's default. */
export function toQuery(
  s: PortfolioStopSetting,
  defaults: PortfolioStopSetting = DEFAULT_SETTING,
): {
  pfstop: string | null;
  pftrail: string | null;
} {
  if (isDefault(s, defaults)) return { pfstop: null, pftrail: null };
  const fields = MODE_FIELDS[s.mode].map((f) => s[f].trim()).join(',');
  return {
    pfstop: s.stop.trim() === '' ? 'off' : s.stop.trim(),
    pftrail: s.mode === 'none' ? null : `${s.mode}:${fields}`,
  };
}

/** The setting a URL carries, or null when it carries none (both values absent). Anything
 * unreadable in it is the default, never an error. */
export function fromQuery(
  pfstop: string | null,
  pftrail: string | null,
  defaults: PortfolioStopSetting = DEFAULT_SETTING,
): PortfolioStopSetting | null {
  if (pfstop === null && pftrail === null) return null;
  const safe = (v: string) => (v.length <= 12 && /^[0-9.,]*$/.test(v) ? v : '');
  const stop = pfstop === null ? defaults.stop : pfstop === 'off' ? '' : safe(pfstop);
  const setting: PortfolioStopSetting = { ...defaults, mode: 'none', stop };
  if (pftrail !== null) {
    const [mode = '', rest = ''] = pftrail.split(':');
    if (mode === 'sl' || mode === 'lock' || mode === 'locktrail') {
      const values = rest.split(',');
      setting.mode = mode;
      MODE_FIELDS[mode].forEach((f, i) => {
        setting[f] = safe(values[i] ?? '');
      });
    }
  }
  return setting;
}
