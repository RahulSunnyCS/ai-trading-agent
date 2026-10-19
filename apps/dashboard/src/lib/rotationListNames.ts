/**
 * Display helpers for the rotation lists; names come from the shared JSON used by Telegram.
 *
 * The journal, the stored results, the API payloads and the pre-registration all key the lists
 * `A`, `B`, `C` and `REF`; those keys never change. Only what a reader SEES is renamed here.
 * Render a list key as text through `listName` (name alone) or `listLabel` (name with the key
 * as a small hint, for places that map back to the journal).
 */

import displayNames from '../../../../packages/option-backtesting/src/option_backtesting/rotation/list_names.json';

export type ListKey = 'A' | 'B' | 'C' | 'REF';

/**
 * THE switch for which lists the dashboard shows (owner, 2026-10-16: only Adaptive is followed).
 * Every screen that enumerates lists (cards, chart lines, table columns, pickers, counters) reads
 * this, never a literal list of keys. The journal still records all four lists (A, B, C, REF: the
 * registered forward test), and the API, the stored results and Telegram are unchanged; only what
 * a reader sees is narrowed. Add a key back here to show that list again.
 */
export const VISIBLE_LIST_KEYS = ['C'] as const satisfies readonly ListKey[];

export type VisibleListKey = (typeof VISIBLE_LIST_KEYS)[number];

/** The list a screen starts on, and the one it falls back to when a choice is not shown. */
export const DEFAULT_LIST: VisibleListKey = VISIBLE_LIST_KEYS[0];

/** Is `key` a list the dashboard shows? False for the hidden lists, the fixed base and the unknown. */
export function isVisibleList(key: string): key is VisibleListKey {
  return (VISIBLE_LIST_KEYS as readonly string[]).includes(key);
}

/** More than one list is shown: a list picker, a comparison across lists, a "lists agree" counter. */
export const SEVERAL_LISTS_VISIBLE: boolean = VISIBLE_LIST_KEYS.length > 1;

/**
 * The pool the live lists rank: the 298 rotation variants ("Core-298" in research). A second pool,
 * Group Leaders (BL-106), may come later as a shadow. Not "base": that word is the fixed base.
 */
export const LIVE_UNIVERSE = { name: 'Core', variants: 298 } as const;

/** "Core (298 variants)". */
export const UNIVERSE_LABEL = `${LIVE_UNIVERSE.name} (${LIVE_UNIVERSE.variants} variants)`;

export interface ListInfo {
  name: string;
  /** One line on what the list is. */
  note: string;
  /** Composite weights, in percent, as registered (own / weekday / DTE / VIX / family). */
  weights: { own: number; weekday: number; dte: number; vix: number; family: number } | null;
}

export const LIST_INFO: Record<ListKey, ListInfo> = {
  A: {
    name: displayNames.A,
    note: 'The safest cell of the weightings.',
    weights: { own: 5, weekday: 34, dte: 33, vix: 23, family: 5 },
  },
  B: {
    name: displayNames.B,
    note: 'Leans on the calendar: weekday and days to expiry.',
    weights: { own: 0, weekday: 36, dte: 35, vix: 24, family: 5 },
  },
  C: {
    name: displayNames.C,
    note: 'Gives its own recent results the most say.',
    weights: { own: 15, weekday: 30, dte: 30, vix: 20, family: 5 },
  },
  REF: {
    name: displayNames.REF,
    note: 'The old live rotation, kept as the comparator.',
    weights: null,
  },
};

export const LIST_NAME: Record<ListKey, string> = {
  A: LIST_INFO.A.name,
  B: LIST_INFO.B.name,
  C: LIST_INFO.C.name,
  REF: LIST_INFO.REF.name,
};

function isListKey(key: string): key is ListKey {
  return key === 'A' || key === 'B' || key === 'C' || key === 'REF';
}

/** The display name of a list key; an unknown key (the fixed base, a future list) is left as is. */
export function listName(key: string): string {
  return isListKey(key) ? LIST_NAME[key] : key;
}

/** A two-letter tag for a space too small for the name (a corner mark in a matrix cell). */
export const LIST_SHORT: Record<ListKey, string> = { A: 'St', B: 'Ca', C: 'Ad', REF: 'Ba' };

export function listShort(key: string): string {
  return isListKey(key) ? LIST_SHORT[key] : key;
}

/** "Steady (A)": the name with its journal key, where a reader may need to map back. */
export function listLabel(key: string): string {
  return isListKey(key) ? `${LIST_NAME[key]} (${key})` : key;
}

/**
 * Server-written text that names a list ("List A: VIX since open"): the key is swapped for the
 * name where it stands alone after the word "list". Display only; the payload is untouched.
 */
export function renameListsIn(text: string): string {
  return text.replace(/\b[Ll]ist (A|B|C|REF)\b/g, (_m, k: string) => `${listName(k)} list`);
}

/**
 * The Rotation page's two Adaptive cards (owner, 2026-10-19), on the dashboard's cards only: the
 * shared `list_names.json`, every other screen and the Telegram messages keep "Adaptive".
 * `classic` is list C of the live journal (Core-298), `tuned` list C of the T1 track's journal.
 */
export const ADAPTIVE_CARD = {
  classic: {
    name: 'Adaptive Classic',
    note: 'The 298 tested variants; gives its own recent results the most say.',
  },
  tuned: {
    name: 'Adaptive Tuned',
    note: 'The same picker with 223 tuned-settings variants added (T1 track).',
  },
} as const satisfies Record<string, { name: string; note: string }>;

/** "Adaptive · Core (298 variants)": a list named with the pool it ranks. */
export function listWithUniverse(key: string): string {
  return `${listName(key)} · ${UNIVERSE_LABEL}`;
}

/** "Steady list": a list named inside a sentence. */
export function listPhrase(key: string): string {
  return isListKey(key) ? `${LIST_NAME[key]} list` : `list ${key}`;
}
