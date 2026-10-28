import { describe, expect, it } from 'vitest';

import type { MomentumLot } from '../../types/momentum';
import { holdsText, lastOrdersText, lotState, plannedGap, plannedText } from '../momentumLots';

function lot(over: Partial<MomentumLot> = {}): MomentumLot {
  return {
    id: 'x',
    label: 'Lot 1',
    sleeve: 'S · Friday 1 of 4',
    holds: [],
    value: 0,
    unpriced: [],
    funded: false,
    due: false,
    next: null,
    last: null,
    pending: false,
    last_orders: null,
    ...over,
  };
}

describe('lotState', () => {
  it('names the due lot with its Friday', () => {
    expect(lotState(lot({ due: true, next: '2026-10-30' }))).toEqual({
      label: 'Due Fri 30 Oct',
      tone: 'primary',
    });
  });
  it('says a lot whose calendar has not reached it yet has not started', () => {
    expect(lotState(lot({ next: '2026-11-06' })).label).toBe('Not started');
  });
  it('a funded lot, or the one the last orders were for, is not due', () => {
    expect(lotState(lot({ funded: true, last: '2026-10-16' })).label).toBe('Not due');
    expect(lotState(lot({ pending: true, last: '2026-10-23' })).label).toBe('Not due');
  });
});

describe('holdsText', () => {
  it('lists the booked shares', () => {
    const holds = [
      { symbol: 'CUPID', shares: 28, close: 1, close_day: null, value: 28 },
      { symbol: 'NAZARA', shares: 24, close: 1, close_day: null, value: 24 },
    ];
    expect(holdsText(lot({ holds }))).toBe('CUPID 28 · NAZARA 24');
  });
  it('says the pending lot books its buys at the next Friday run', () => {
    expect(holdsText(lot({ pending: true }))).toMatch(/booked at the next Friday run/);
  });
});

describe('lastOrdersText', () => {
  it('gives the budget of a new or rebalancing lot, as the Telegram does', () => {
    expect(lastOrdersText(lot({ last_orders: { status: 'new', budget: 50000, next: null } }))).toBe(
      'New lot: buy · ₹50,000',
    );
    expect(
      lastOrdersText(lot({ last_orders: { status: 'not due', budget: null, next: '2026-11-13' } })),
    ).toBe('Not due');
    expect(lastOrdersText(lot())).toBeNull();
  });
});

describe('planned', () => {
  it('says what the orders told each lot and how Kite differs', () => {
    expect(plannedText([{ lot: 'Lot 2', shares: 30 }])).toBe('Lot 2: buy 30');
    expect(plannedText([{ lot: 'Lot 1', shares: -4 }])).toBe('Lot 1: sell 4');
    expect(plannedText([])).toBe('not in the last orders');
    expect(plannedGap(30, [{ lot: 'Lot 2', shares: 30 }])).toBeNull();
    expect(plannedGap(2, [{ lot: 'Lot 2', shares: 1 }])).toBe('1 more than the orders said');
    expect(plannedGap(1, [{ lot: 'Lot 2', shares: 3 }])).toBe('2 fewer than the orders said');
    expect(plannedGap(5, [])).toBeNull();
  });
});
