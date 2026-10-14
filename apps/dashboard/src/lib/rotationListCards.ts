/**
 * The Today page's three list cards (BL-102): Steady, Calendar and Adaptive, each with its latest
 * scored day, its total and drawdown since the forward test began, and how it stands against the
 * fixed base. Pure, so it is unit-tested; the figures are the read-out's, nothing is recomputed.
 *
 * Gross, two lots a strategy. A day not yet scored is absent, never a zero. Baseline (REF) is a
 * comparator in the page's settings, not a card.
 */

import type { RotationListKey, RotationSummary } from '../types/rotation';
import { LIST_INFO } from './rotationListNames';

export const CARD_KEYS = ['A', 'B', 'C'] as const;
export type CardKey = (typeof CARD_KEYS)[number];

export interface ListCard {
  key: CardKey;
  name: string;
  note: string;
  /** The latest scored day and the list's gross that day (two lots a strategy), if any. */
  latest: { day: string; total: number } | null;
  /** Gross since the first scored forward day; null before there is one. */
  total: number | null;
  maxDrawdown: number | null;
  /** Mean daily gap to the fixed base, per lot-day, and whether the registered rule is met. */
  vsBase: number | null;
  /** Scored forward days behind these figures. */
  days: number;
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

/** One card per list in A, B, C order. `summary` null (not read yet) gives cards of dashes. */
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
      vsBase: stats && scored ? stats.vs_base.mean : null,
      days: summary?.n_days ?? 0,
    };
  });
}
