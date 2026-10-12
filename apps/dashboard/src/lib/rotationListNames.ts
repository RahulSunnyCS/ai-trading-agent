/**
 * The one place the rotation lists' display names live.
 *
 * The journal, the stored results, the API payloads and the pre-registration all key the lists
 * `A`, `B`, `C` and `REF`; those keys never change. Only what a reader SEES is renamed here.
 * Render a list key as text through `listName` (name alone) or `listLabel` (name with the key
 * as a small hint, for places that map back to the journal).
 */

export type ListKey = 'A' | 'B' | 'C' | 'REF';

export interface ListInfo {
  name: string;
  /** One line on what the list is. */
  note: string;
  /** Composite weights, in percent, as registered (own / weekday / DTE / VIX / family). */
  weights: { own: number; weekday: number; dte: number; vix: number; family: number } | null;
}

export const LIST_INFO: Record<ListKey, ListInfo> = {
  A: {
    name: 'Steady',
    note: 'The safest cell of the weightings.',
    weights: { own: 5, weekday: 34, dte: 33, vix: 23, family: 5 },
  },
  B: {
    name: 'Calendar',
    note: 'Leans on the calendar: weekday and days to expiry.',
    weights: { own: 0, weekday: 36, dte: 35, vix: 24, family: 5 },
  },
  C: {
    name: 'Adaptive',
    note: 'Gives its own recent results the most say.',
    weights: { own: 15, weekday: 30, dte: 30, vix: 20, family: 5 },
  },
  REF: {
    name: 'Baseline',
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

/** "Steady list": a list named inside a sentence. */
export function listPhrase(key: string): string {
  return isListKey(key) ? `${LIST_NAME[key]} list` : `list ${key}`;
}
