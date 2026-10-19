import { describe, expect, it } from 'vitest';

import type { RotationSummary } from '../../types/rotation';
import { CARD_KEYS, listCards, tunedCard } from '../rotationListCards';

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
      A: stats(8868, -8708, -300),
      B: stats(8868, -8708, -300),
      C: stats(25025, 0, 1062),
      REF: stats(5902, -848, 0),
    },
    days: [
      { day: '2026-10-12', base: 0, base_total: 0, A_total: 1000, B_total: -500, C_total: 1000 },
      { day: '2026-10-13', base: 0, base_total: 0, A_total: 2000, B_total: 3000, C_total: 2000 },
      { day: '2026-10-14', base: 0, base_total: 0, A_total: 0, B_total: 0, C_total: -250 },
    ],
    ...over,
  } as unknown as RotationSummary;
}

describe('listCards', () => {
  it('has one card, Adaptive Classic, never Steady, Calendar or Baseline', () => {
    const cards = listCards(summary());
    expect(CARD_KEYS).toEqual(['C']);
    expect(cards.map((c) => c.key)).toEqual(['C']);
    expect(cards.map((c) => c.name)).toEqual(['Adaptive Classic']);
  });

  it("reads the list's latest day, total, drawdown and gap to the base", () => {
    const [c] = listCards(summary());
    expect(c?.latest).toEqual({ day: '2026-10-14', total: -250 });
    expect(c?.total).toBe(25025);
    expect(c?.maxDrawdown).toBe(0);
    expect(c?.vsBase).toBe(1062);
    const worse = summary({
      lists: { ...summary().lists, C: stats(8868, -8708, -300) },
    });
    expect(listCards(worse)[0]?.maxDrawdown).toBe(-8708);
    expect(listCards(worse)[0]?.vsBase).toBe(-300);
  });

  it('treats a real zero as a value, not as missing', () => {
    const s = summary({
      days: [
        { day: '2026-10-13', base: 0, base_total: 0, C_total: 2000 },
        { day: '2026-10-14', base: 0, base_total: 0, C_total: 0 },
      ] as never,
    });
    expect(listCards(s)[0]?.latest).toEqual({ day: '2026-10-14', total: 0 });
  });

  it('skips a day a list has no total for and uses the one before', () => {
    const s = summary({
      days: [
        { day: '2026-10-12', C_total: 1000 },
        { day: '2026-10-13', C_total: 2000 },
        // a hidden list's figure on the last day does not count as Adaptive's
        { day: '2026-10-14', A_total: 500 },
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

describe('tunedCard', () => {
  it("is Adaptive Tuned, list C of the T1 track's read-out", () => {
    const t1 = summary({ lists: { C: stats(4000, -1200, 250) } as never });
    const card = tunedCard(t1);
    expect(card).toMatchObject({ key: 'C', id: 'T1', name: 'Adaptive Tuned' });
    expect(card.note).toMatch(/T1 track/);
    expect(card.total).toBe(4000);
    expect(card.maxDrawdown).toBe(-1200);
    expect(card.vsBase).toBe(250);
    expect(card.latest).toEqual({ day: '2026-10-14', total: -250 });
    expect(listCards(t1)[0]?.id).toBe('C'); // the two cards never share an id
  });

  it('gives dashes before the track has a scored day', () => {
    const card = tunedCard(summary({ n_days: 0, days: [] }));
    expect([card.latest, card.total, card.maxDrawdown, card.vsBase]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(tunedCard(null).name).toBe('Adaptive Tuned');
  });
});
