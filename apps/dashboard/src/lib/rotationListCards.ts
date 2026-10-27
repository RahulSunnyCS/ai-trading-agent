/**
 * The rotation lists that get a book of their own (BL-102): the shown lists (`VISIBLE_LIST_KEYS`)
 * except Baseline (REF), which is a comparator. Used by Strategies and baskets; the Today page's
 * Books table is `lib/rotationBooks.ts` (dashboard review, 2026-10-28).
 */

import { type ListKey, VISIBLE_LIST_KEYS } from './rotationListNames';

export type CardKey = Exclude<ListKey, 'REF'>;

/** The shown lists that get a card: Baseline never does, it is a comparator. */
export const CARD_KEYS: readonly CardKey[] = (VISIBLE_LIST_KEYS as readonly ListKey[]).filter(
  (k): k is CardKey => k !== 'REF',
);
