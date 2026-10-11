import { describe, expect, it } from 'vitest';

import type { RotationSummary } from '../../types/rotation';
import type { PortfolioDays } from '../../types/rotationPortfolio';
import { hasOverlay, overlayBook, overlaySummary, stopFlag } from '../rotationPortfolioView';
import { ROWS } from './rotationDailyLogFixture';

function book(
  day: string,
  over: Partial<PortfolioDays['rows'][number]['lists']['A'] & object>,
): PortfolioDays {
  return {
    basis: 'gross',
    source: 'recorded',
    setting: { amount: 10000, trail: null },
    rows: [
      {
        day,
        lists: {
          A: {
            lots: 6,
            gross_log: 0,
            gross_without: 0,
            gross_with: -10361,
            stop_minute: 119,
            stop_label: '11:14',
            fired_by: 'stop',
            matches_log: true,
            ...over,
          },
        },
      },
    ],
    errors: [],
    totals: {},
  };
}

const scored = ROWS.find((r) => r.lists.A?.per_lot_day != null && r.lists.A.lots > 0);

describe('overlayBook', () => {
  it('returns the log rows untouched without a book', () => {
    expect(overlayBook(ROWS, null)).toBe(ROWS);
    expect(hasOverlay(ROWS)).toBe(false);
  });

  it('replaces gross and per lot-day with the stopped figure and keeps what the log showed', () => {
    expect(scored).toBeDefined();
    if (!scored) return;
    const out = overlayBook(ROWS, book(scored.day, {}));
    const row = out.find((r) => r.day === scored.day);
    const a = row?.lists.A;
    expect(a?.gross).toBe(-10361);
    expect(a?.per_lot_day).toBeCloseTo(-10361 / scored.lists.A!.lots, 6);
    expect(a?.pf).toEqual({
      gross_without: scored.lists.A!.gross,
      per_lot_day_without: scored.lists.A!.per_lot_day,
      stop_label: '11:14',
      fired_by: 'stop',
    });
    expect(hasOverlay(out)).toBe(true);
    // the other lists and days are the same objects
    expect(out.find((r) => r.day !== scored.day)).toBe(ROWS.find((r) => r.day !== scored.day));
    expect(row?.lists.B).toBe(scored.lists.B);
  });

  it('leaves a list with no stored figure as the log has it', () => {
    const waiting = ROWS.find((r) => r.lists.A && r.lists.A.gross === null);
    if (!waiting) return;
    const out = overlayBook(ROWS, book(waiting.day, {}));
    expect(out.find((r) => r.day === waiting.day)).toBe(waiting);
  });
});

describe('stopFlag', () => {
  it('names the focus list stop minute, else the first list that stopped', () => {
    expect(scored).toBeDefined();
    if (!scored) return;
    const row = overlayBook(ROWS, book(scored.day, {})).find((r) => r.day === scored.day)!;
    expect(stopFlag(row, 'A')?.label).toBe('PF stop 11:14');
    expect(stopFlag(row, 'REF')?.label).toBe('PF stop 11:14'); // REF did not stop; A did
    expect(stopFlag(scored, 'A')).toBeNull();
  });

  it('says profit lock for a lock', () => {
    if (!scored) return;
    const row = overlayBook(ROWS, book(scored.day, { fired_by: 'lock' })).find(
      (r) => r.day === scored.day,
    )!;
    expect(stopFlag(row, 'A')?.title).toMatch(/profit lock at 11:14/);
  });
});

describe('overlaySummary', () => {
  const stats = {
    total: 0,
    mean_day: 0,
    per_lot_day: 0,
    lots_per_day: 6,
    max_drawdown: 0,
    max_drawdown_per_lot: 0,
    beats_random_pct: 71,
    random: { p10: 0, p50: 0, p90: 0, max: 0 },
    mean_daily_random_percentile: 50,
    random_path: { p10: [], p50: [], p90: [] },
    vs_base: { mean: 5, lower: -1, upper: 9, drawdown_no_worse: true, beats_base: true },
    vs_ref: null,
  };
  const summary = {
    settings: {},
    n_days: 3,
    first_day: '2026-10-12',
    last_day: '2026-10-14',
    pending_days: [],
    pending_reasons: {},
    late_entries: [],
    short: true,
    lists: { A: { ...stats }, REF: { ...stats } },
    base: null,
    days: [
      { day: '2026-10-12', base: 0, base_total: 0, A: 100, A_total: 600, REF: 50, REF_total: 300 },
      {
        day: '2026-10-13',
        base: 0,
        base_total: 0,
        A: -3000,
        A_total: -18000,
        REF: -10,
        REF_total: -60,
      },
      { day: '2026-10-14', base: 0, base_total: 0, A: 200, A_total: 1200, REF: 20, REF_total: 120 },
    ],
  } as unknown as RotationSummary;

  const book: PortfolioDays = {
    basis: 'gross',
    source: 'recorded',
    setting: { amount: 10000, trail: null },
    rows: [
      {
        day: '2026-10-13',
        lists: {
          A: {
            lots: 6,
            gross_log: -18000,
            gross_without: -18000,
            gross_with: -10000,
            stop_minute: 100,
            stop_label: '10:55',
            fired_by: 'stop',
            matches_log: true,
          },
        },
      },
    ],
    errors: [],
    totals: {},
  };

  it('is the read-out itself without a book or without days', () => {
    expect(overlaySummary(summary, null)).toBe(summary);
    expect(overlaySummary({ ...summary, days: [] }, book).days).toEqual([]);
  });

  it('replaces the stopped day and recomputes the figures that follow from the days', () => {
    const out = overlaySummary(summary, book);
    const day = out.days?.[1];
    expect(day?.A_total).toBe(-10000);
    expect(day?.A).toBeCloseTo(-10000 / 6, 6);
    expect(day?.REF_total).toBe(-60); // no figure for REF: untouched
    const a = out.lists.A;
    expect(a?.total).toBe(600 - 10000 + 1200);
    expect(a?.per_lot_day).toBeCloseTo((100 - 10000 / 6 + 200) / 3, 6);
    expect(a?.max_drawdown).toBe(-10000);
    expect(a?.max_drawdown_per_lot).toBeCloseTo(-10000 / 6, 6);
    // what needs the registered machinery is left as the read-out has it
    expect(a?.beats_random_pct).toBe(71);
    expect(a?.vs_base).toEqual(summary.lists.A?.vs_base);
    // the read-out's own object is not mutated
    expect(summary.days?.[1]?.A_total).toBe(-18000);
  });
});
