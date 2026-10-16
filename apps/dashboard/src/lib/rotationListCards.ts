/**
 * The Today page's list cards (BL-102): one per shown list (`VISIBLE_LIST_KEYS`), each with its
 * latest scored day, its total and drawdown since the forward test began, and how it stands
 * against the fixed base. Pure, so it is unit-tested; the figures are the read-out's, nothing is
 * recomputed.
 *
 * Gross, two lots a strategy. A day not yet scored is absent, never a zero. Baseline (REF) is a
 * comparator in the page's settings, not a card.
 */

import type { RotationListKey, RotationSummary } from '../types/rotation';
import { LIST_INFO, type ListKey, VISIBLE_LIST_KEYS } from './rotationListNames';

export type CardKey = Exclude<ListKey, 'REF'>;

/** The shown lists that get a card: Baseline never does, it is a comparator. */
export const CARD_KEYS: readonly CardKey[] = (VISIBLE_LIST_KEYS as readonly ListKey[]).filter(
  (k): k is CardKey => k !== 'REF',
);

export interface ListCard {
  key: CardKey;
  name: string;
  note: string;
  /** The latest scored day and the list's gross that day (two lots a strategy), if any. */
  latest: { day: string; total: number } | null;
  /** Gross since the first scored forward day; null before there is one. */
  total: number | null;
  maxDrawdown: number | null;
  /**
   * Mean daily gap to the fixed base, per lot-day: the list's own per-lot-day figure minus the
   * base's. Worked out here, from the same figures as the headline, so it follows a portfolio
   * stop when one is applied (the read-out's `vs_base` interval stays on the registered basis).
   */
  vsBase: number | null;
}

function latestOf(summary: RotationSummary, key: RotationListKey) {
  const rows = summary.days ?? [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const value = row?.[`${key}_total`];
    if (row && typeof value === 'number') return { day: row.day, total: value };
  }
  return null;
}

/** One card per shown list, in key order. `summary` null (not read yet) gives cards of dashes. */
export function listCards(summary: RotationSummary | null): ListCard[] {
  return CARD_KEYS.map((key) => {
    const info = LIST_INFO[key];
    const stats = summary?.lists[key];
    const scored = (summary?.n_days ?? 0) > 0;
    return {
      key,
      name: info.name,
      note: info.note,
      latest: summary && scored ? latestOf(summary, key) : null,
      total: stats && scored ? stats.total : null,
      maxDrawdown: stats && scored ? stats.max_drawdown : null,
      vsBase:
        stats && scored && summary?.base ? stats.per_lot_day - summary.base.per_lot_day : null,
    };
  });
}
