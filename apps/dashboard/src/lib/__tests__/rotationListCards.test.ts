import { describe, expect, it } from 'vitest';

import type { RotationSummary } from '../../types/rotation';
import { CARD_KEYS, listCards } from '../rotationListCards';

// vs the base is the list's per-lot-day minus the base's (100), so a stop carries through.
const stats = (total: number, dd: number, vs: number) =>
  ({
    total,
    max_drawdown: dd,
    per_lot_day: 100 + vs,
    vs_base: { mean: 0, lower: 0, upper: 0 },
  }) as never;

function summary(over: Partial<RotationSummary> = {}): RotationSummary {
  return {
    n_days: 3,
    base: { per_lot_day: 100 },
    first_day: '2026-10-12',
    last_day: '2026-10-14',
    lists: {
      A: stats(25025, 0, 1062),
      B: stats(8868, -8708, -300),
      C: stats(25025, 0, 1062),
      REF: stats(5902, -848, 0),
    },
    days: [
      { day: '2026-10-12', base: 0, base_total: 0, A_total: 1000, B_total: -500, C_total: 1000 },
      { day: '2026-10-13', base: 0, base_total: 0, A_total: 2000, B_total: 3000, C_total: 2000 },
      { day: '2026-10-14', base: 0, base_total: 0, A_total: -250, B_total: 0, C_total: -250 },
    ],
    ...over,
  } as unknown as RotationSummary;
}

describe('listCards', () => {
  it('has Steady, Calendar and Adaptive in order, never Baseline', () => {
    const cards = listCards(summary());
    expect(cards.map((c) => c.key)).toEqual([...CARD_KEYS]);
    expect(cards.map((c) => c.name)).toEqual(['Steady', 'Calendar', 'Adaptive']);
  });

  it("reads each list's latest day, total, drawdown and gap to the base", () => {
    const [a, b] = listCards(summary());
    expect(a?.latest).toEqual({ day: '2026-10-14', total: -250 });
    expect(a?.total).toBe(25025);
    expect(a?.maxDrawdown).toBe(0);
    expect(a?.vsBase).toBe(1062);
    expect(b?.maxDrawdown).toBe(-8708);
    expect(b?.vsBase).toBe(-300);
  });

  it('treats a real zero as a value, not as missing', () => {
    const [, b] = listCards(summary());
    expect(b?.latest).toEqual({ day: '2026-10-14', total: 0 });
  });

  it('skips a day a list has no total for and uses the one before', () => {
    const s = summary({
      days: [
        { day: '2026-10-12', A_total: 1000 },
        { day: '2026-10-13', A_total: 2000 },
        { day: '2026-10-14' },
      ] as never,
    });
    expect(listCards(s)[0]?.latest).toEqual({ day: '2026-10-13', total: 2000 });
  });

  it('gives dashes before there is a scored day and before the read-out has loaded', () => {
    for (const s of [null, summary({ n_days: 0, days: [] })]) {
      for (const c of listCards(s)) {
        expect([c.latest, c.total, c.maxDrawdown, c.vsBase]).toEqual([null, null, null, null]);
      }
    }
  });
});
