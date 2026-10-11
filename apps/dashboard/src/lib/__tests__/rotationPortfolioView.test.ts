import { describe, expect, it } from 'vitest';

import type { PortfolioDays } from '../../types/rotationPortfolio';
import { hasOverlay, overlayBook, stopFlag } from '../rotationPortfolioView';
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
