/**
 * The Today page's Books table (dashboard review, 2026-10-28): one row per book the page follows
 * (Adaptive Classic, Adaptive Tuned, the Fixed base), replacing the three list cards and the
 * headline strip, which showed the same figures twice. Pure, so it is unit-tested; every figure is
 * the read-out's (`lib/rotationListCards.ts` reads the same fields), nothing is recomputed.
 *
 * Gross, at the lots the page asked the read-out for (1 a strategy). A day not yet scored is a
 * dash, never a zero. "Beats random baskets" always stays on the registered basis (no stop).
 */

import type { RotationListStats, RotationSummary } from '../types/rotation';
import type { StopEffect } from './rotationPortfolioView';
import { type RotationBenchmark, benchmarkFigures } from './rotationView';

export type BookId = 'C' | 'T1' | 'BASE';

export interface BookRow {
  id: BookId;
  /** The latest scored day and the book's gross that day. */
  latest: { day: string; total: number } | null;
  /** Gross since the book's first scored forward day. */
  total: number | null;
  /** That first day (Tuned starts later than Classic). */
  firstDay: string | null;
  scoredDays: number;
  perLotDay: number | null;
  maxDrawdown: number | null;
  maxDrawdownPerLot: number | null;
  /** Per lot-day, the book minus the picked benchmark (null for the base against itself). */
  vsBenchmark: number | null;
  /** Share of random same-shape baskets beaten, registered basis; null for the base. */
  beatsRandom: number | null;
}

function latestOf(summary: RotationSummary, field: string) {
  const rows = summary.days ?? [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const value = row?.[field];
    if (row && typeof value === 'number') return { day: row.day, total: value };
  }
  return null;
}

function empty(id: BookId): BookRow {
  return {
    id,
    latest: null,
    total: null,
    firstDay: null,
    scoredDays: 0,
    perLotDay: null,
    maxDrawdown: null,
    maxDrawdownPerLot: null,
    vsBenchmark: null,
    beatsRandom: null,
  };
}

/**
 * A list book (Classic: the live journal's list C; Tuned: the T1 track's). `shown` carries the
 * figures the page shows (with the portfolio stop laid over when one is applied); `registered`
 * is the same read-out without it, for "beats random baskets".
 */
export function listBook(
  id: 'C' | 'T1',
  shown: RotationSummary | null,
  registered: RotationSummary | null,
  pick: RotationBenchmark,
): BookRow {
  const stats: RotationListStats | undefined = shown?.lists.C;
  if (!shown || !stats || shown.n_days <= 0) return empty(id);
  const bench = benchmarkFigures(shown, pick, 'C').perLotDay;
  return {
    id,
    latest: latestOf(shown, 'C_total'),
    total: stats.total,
    firstDay: shown.first_day,
    scoredDays: shown.n_days,
    perLotDay: stats.per_lot_day,
    maxDrawdown: stats.max_drawdown,
    maxDrawdownPerLot: stats.max_drawdown_per_lot,
    vsBenchmark: bench === null ? null : stats.per_lot_day - bench,
    beatsRandom: registered?.lists.C?.beats_random_pct ?? null,
  };
}

/** The Fixed base over Classic's scored sessions, with its own stop laid over when applied. */
export function baseBook(shown: RotationSummary | null): BookRow {
  const b = shown?.base;
  if (!shown || !b || shown.n_days <= 0) return empty('BASE');
  return {
    id: 'BASE',
    latest: latestOf(shown, 'base_total'),
    total: b.total,
    firstDay: shown.first_day,
    scoredDays: shown.n_days,
    perLotDay: b.per_lot_day,
    maxDrawdown: b.max_drawdown,
    maxDrawdownPerLot: b.max_drawdown_per_lot,
    vsBenchmark: null,
    beatsRandom: null,
  };
}

/** True when the stop changed a figure the row shows: a total, a drawdown or a fired day. */
export function stopChanged(e: StopEffect | null): boolean {
  if (e === null) return false;
  return (
    Math.round(e.totalWith) !== Math.round(e.totalWithout) ||
    Math.round(e.ddWith) !== Math.round(e.ddWithout)
  );
}

/**
 * The stop cell's one line: "fired 1 of 10 · changed ₹0" in words the formatter fills. Returns the
 * parts so the component formats the money; null before the replay is in.
 */
export function stopSummary(e: StopEffect | null): {
  fired: number;
  days: number;
  change: number;
  skipped: number;
} | null {
  if (e === null) return null;
  return {
    fired: e.firedDays,
    days: e.days,
    change: e.totalWith - e.totalWithout,
    skipped: e.skipped,
  };
}

/** The column header of the gap: what the per-lot-day gap is measured against. */
export function vsHeader(pick: RotationBenchmark): string {
  return pick === 'random' ? 'vs random median' : pick === 'REF' ? 'vs Baseline' : 'vs base';
}
