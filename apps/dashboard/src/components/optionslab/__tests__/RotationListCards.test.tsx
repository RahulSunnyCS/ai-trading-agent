// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RotationBasket, RotationSummary } from '../../../types/rotation';
import { RotationListCards } from '../rotation/RotationListCards';

afterEach(cleanup);

const stats = (total: number, perLotDay = 150) =>
  ({
    total,
    max_drawdown: -100,
    per_lot_day: perLotDay,
    vs_base: { mean: 50, lower: 0, upper: 0 },
  }) as never;

// The read-out carries all four lists; only Adaptive (C) is shown.
const summary = {
  n_days: 2,
  base: { per_lot_day: 100 },
  lists: { A: stats(1000), B: stats(1000), C: stats(-2000, -40), REF: stats(5) },
  days: [{ day: '2026-10-14', A_total: 400, B_total: 400, C_total: -300, REF_total: 1 }],
} as unknown as RotationSummary;

const pick = (name: string, start: string) => ({ name, start }) as never;
const baskets = {
  A: { core: [pick('N_wide_1017', '10:17')], buy: [] },
  C: {
    core: [pick('N_wide_0917', '09:17'), pick('N_dir_0924', '09:24')],
    buy: [pick('N_buy_0935', '09:35')],
  },
} as unknown as Partial<Record<'A' | 'B' | 'C' | 'REF', RotationBasket>>;

function renderCards(
  s: RotationSummary | null = summary,
  entryDay: string | null = '2026-10-14',
  b: Partial<Record<'A' | 'B' | 'C' | 'REF', RotationBasket>> = baskets,
) {
  const onFocus = vi.fn();
  render(
    <RotationListCards
      summary={s}
      baskets={b}
      entryDay={entryDay}
      today="2026-10-14"
      focus="C"
      onFocus={onFocus}
    />,
  );
  return onFocus;
}

describe('RotationListCards', () => {
  it('shows the Adaptive card alone: no Steady, Calendar or Baseline card', () => {
    renderCards();
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Adaptive list' })).toBeTruthy();
    for (const name of ['Steady', 'Calendar', 'Baseline']) {
      expect(screen.queryByRole('region', { name: new RegExp(name) })).toBeNull();
      expect(screen.queryByText(new RegExp(name))).toBeNull();
    }
  });

  it('shows the latest scored day and the totals with their signs', () => {
    renderCards();
    const card = screen.getByRole('region', { name: 'Adaptive list' });
    expect(within(card).getByText('-₹300')).toBeTruthy();
    expect(within(card).getByText('-₹2,000')).toBeTruthy();
    expect(within(card).getByText(/Latest scored day, /)).toBeTruthy();
  });

  it('has no focus button or focus mark with one list: there is nothing to switch to', () => {
    renderCards();
    const card = screen.getByRole('region', { name: 'Adaptive list' });
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(card).queryByText('focus')).toBeNull();
  });

  it("lists today's picks, collapsed, when the list has them", () => {
    renderCards();
    const card = screen.getByRole('region', { name: 'Adaptive list' });
    expect(within(card).getByText("Today's 3 picks")).toBeTruthy();
    expect(within(card).getByText('N_buy_0935')).toBeTruthy();
    // Steady's basket is in the payload, never drawn
    expect(screen.queryByText('N_wide_1017')).toBeNull();
  });

  it('shows no picks when the shown list has none, even if a hidden list has', () => {
    renderCards(summary, '2026-10-14', { A: baskets.A } as never);
    expect(screen.queryByText(/picks/)).toBeNull();
  });

  it("says whose day the picks are when they are not today's", () => {
    renderCards(summary, '2026-10-13');
    const card = screen.getByRole('region', { name: 'Adaptive list' });
    expect(within(card).getByText(/3 picks recorded for /)).toBeTruthy();
    expect(within(card).queryByText("Today's 3 picks")).toBeNull();
  });

  it('shows the gap to the base from per-lot-day figures, so a stop carries through', () => {
    renderCards();
    expect(
      within(screen.getByRole('region', { name: 'Adaptive list' })).getByText('-₹140 / lot-day'),
    ).toBeTruthy();
  });

  it('shows dashes, not zeros, before the first scored day', () => {
    renderCards(null);
    const card = screen.getByRole('region', { name: 'Adaptive list' });
    expect(within(card).getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });
});
