/**
 * The one-line basket row on Options Lab › Strategies and baskets: a list's forward days, the
 * first day, its gross since then and its max drawdown, from the same read-out the Today page
 * reads (`/legwise/rotation/summary?lots=ROTATION_PAGE_LOTS`) and through the Today cards' own
 * shaping (`listCards`), so the two pages show the same figures. Pure, so it is unit-tested.
 *
 * The card used to ask the registered read-out (no `lots`), a different cache key from
 * Today's, so it waited on a cold build of the 1,000 random baskets and showed "Forward days —"
 * and "Max drawdown —" with nothing saying it was loading; "Forward days" was a fallback label,
 * never a count. Every state now says what it is: loading, unreadable, nothing scored yet.
 */

import type { RotationSummary } from '../types/rotation';
import { type CardKey, listCards } from './rotationListCards';

export type BasketLine =
  | { state: 'loading' }
  | { state: 'error'; reason: string }
  | { state: 'none' }
  | { state: 'missing' }
  | {
      state: 'ready';
      /** Scored forward days (the read-out's `n_days`). */
      forwardDays: number;
      firstDay: string | null;
      /** Gross since the first scored day, at the lots the read-out was asked for. */
      total: number;
      maxDrawdown: number;
    };

export function basketLine(
  summary: RotationSummary | null,
  key: CardKey,
  error: string | null,
): BasketLine {
  if (!summary) return error ? { state: 'error', reason: error } : { state: 'loading' };
  if (summary.n_days <= 0) return { state: 'none' };
  const card = listCards(summary).find((c) => c.key === key);
  if (!card || card.total === null || card.maxDrawdown === null) return { state: 'missing' };
  return {
    state: 'ready',
    forwardDays: summary.n_days,
    firstDay: summary.first_day,
    total: card.total,
    maxDrawdown: card.maxDrawdown,
  };
}
