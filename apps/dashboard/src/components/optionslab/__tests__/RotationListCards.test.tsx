// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

const summary = {
  n_days: 2,
  base: { per_lot_day: 100 },
  lists: { A: stats(1000), B: stats(-2000, -40), C: stats(1000) },
  days: [{ day: '2026-10-14', A_total: 400, B_total: -300, C_total: 400 }],
} as unknown as RotationSummary;

const pick = (name: string, start: string) => ({ name, start }) as never;
const baskets = {
  A: {
    core: [pick('N_wide_0917', '09:17'), pick('N_dir_0924', '09:24')],
    buy: [pick('N_buy_0935', '09:35')],
  },
} as unknown as Partial<Record<'A' | 'B' | 'C' | 'REF', RotationBasket>>;

function renderCards(
  focus: 'A' | 'B' | 'C' | 'REF' = 'A',
  s: RotationSummary | null = summary,
  entryDay: string | null = '2026-10-14',
) {
  const onFocus = vi.fn();
  render(
    <RotationListCards
      summary={s}
      baskets={baskets}
      entryDay={entryDay}
      today="2026-10-14"
      focus={focus}
      onFocus={onFocus}
    />,
  );
  return onFocus;
}

describe('RotationListCards', () => {
  it('shows the three lists by name, and no Baseline card', () => {
    renderCards();
    for (const name of ['Steady', 'Calendar', 'Adaptive']) {
      expect(screen.getByRole('region', { name: `${name} list` })).toBeTruthy();
    }
    expect(screen.queryByRole('region', { name: /Baseline/ })).toBeNull();
  });

  it('shows the latest scored day and the totals with their signs', () => {
    renderCards();
    const calendar = screen.getByRole('region', { name: 'Calendar list' });
    expect(within(calendar).getByText('-₹300')).toBeTruthy();
    expect(within(calendar).getByText('-₹2,000')).toBeTruthy();
    expect(within(calendar).getByText(/Latest scored day, /)).toBeTruthy();
  });

  it('marks the focus list and moves the focus on a click', () => {
    const onFocus = renderCards('B');
    const calendar = screen.getByRole('region', { name: 'Calendar list' });
    expect(within(calendar).getByRole('button', { pressed: true })).toBeTruthy();
    const steady = screen.getByRole('region', { name: 'Steady list' });
    fireEvent.click(within(steady).getByRole('button'));
    expect(onFocus).toHaveBeenCalledWith('A');
  });

  it("lists today's picks, collapsed, when the list has them", () => {
    renderCards();
    const steady = screen.getByRole('region', { name: 'Steady list' });
    expect(within(steady).getByText("Today's 3 picks")).toBeTruthy();
    expect(within(steady).getByText('N_buy_0935')).toBeTruthy();
    const calendar = screen.getByRole('region', { name: 'Calendar list' });
    expect(within(calendar).queryByText(/picks/)).toBeNull();
  });

  it("says whose day the picks are when they are not today's", () => {
    renderCards('A', summary, '2026-10-13');
    const steady = screen.getByRole('region', { name: 'Steady list' });
    expect(within(steady).getByText(/3 picks recorded for /)).toBeTruthy();
    expect(within(steady).queryByText("Today's 3 picks")).toBeNull();
  });

  it('shows the gap to the base from per-lot-day figures, so a stop carries through', () => {
    renderCards();
    expect(
      within(screen.getByRole('region', { name: 'Steady list' })).getByText('+₹50 / lot-day'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Calendar list' })).getByText('-₹140 / lot-day'),
    ).toBeTruthy();
  });

  it('outlines no card when Baseline is the focus, and a click still picks a list', () => {
    const onFocus = renderCards('REF');
    for (const name of ['Steady', 'Calendar', 'Adaptive']) {
      const card = screen.getByRole('region', { name: `${name} list` });
      expect(within(card).getByRole('button', { pressed: false })).toBeTruthy();
    }
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Adaptive list' })).getByRole('button'),
    );
    expect(onFocus).toHaveBeenCalledWith('C');
  });

  it('shows dashes, not zeros, before the first scored day', () => {
    renderCards('A', null);
    const steady = screen.getByRole('region', { name: 'Steady list' });
    expect(within(steady).getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });
});
