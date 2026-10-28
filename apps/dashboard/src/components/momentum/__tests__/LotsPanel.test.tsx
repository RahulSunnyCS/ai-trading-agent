// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MomentumLot, MomentumLotsView } from '../../../types/momentum';

const calls: string[] = [];
let response: MomentumLotsView | null = null;
let error: string | null = null;
let refetches = 0;

vi.mock('../../../hooks/usePolledResource', () => ({
  usePolledResource: (url: string) => {
    calls.push(url);
    return {
      data: response,
      loading: false,
      error,
      refetch: () => {
        refetches += 1;
      },
    };
  },
}));

const { LotsPanel } = await import('../week/LotsPanel');

afterEach(() => {
  cleanup();
  calls.length = 0;
  response = null;
  error = null;
  refetches = 0;
});

function lot(over: Partial<MomentumLot>): MomentumLot {
  return {
    id: 'x',
    label: 'Lot 1',
    sleeve: 'Four Sectors · Friday 4 of 4',
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

/** A made-up ledger shaped like a ramp-up week: one funded lot, one bought but not yet booked. */
const LIVE: MomentumLotsView = {
  available: true,
  group: 'Four Sectors Monthly, No Tilt · all Fridays',
  group_id: 'g',
  week: '2026-10-30',
  paper_start: '2026-10-16',
  holdings_source: 'kite',
  snapshot: { synced_at: '2026-10-28T08:51:01+05:30', cash: 500, today: true },
  pending: 'Lot 2',
  close_days: ['2026-10-23', '2026-10-23'],
  lots: [
    lot({
      id: 'l1',
      label: 'Lot 1',
      holds: [
        { symbol: 'CUPID', shares: 28, close: 306.45, close_day: '2026-10-23', value: 8580.6 },
        { symbol: 'GRWRHITECH', shares: 1, close: 7034, close_day: '2026-10-23', value: 7034 },
        { symbol: 'NAZARA', shares: 24, close: 402.15, close_day: '2026-10-23', value: 9651.6 },
        { symbol: 'RATEGAIN', shares: 12, close: 764.1, close_day: '2026-10-23', value: 9169.2 },
      ],
      value: 34435.4,
      funded: true,
      next: '2026-11-13',
      last: '2026-10-16',
      last_orders: { status: 'not due', budget: null, next: '2026-11-13' },
    }),
    lot({
      id: 'l2',
      label: 'Lot 2',
      next: '2026-11-20',
      last: '2026-10-23',
      pending: true,
      last_orders: { status: 'new', budget: 50000, next: '2026-11-20' },
    }),
    lot({
      id: 'l3',
      label: 'Lot 3',
      due: true,
      next: '2026-10-30',
      last_orders: { status: 'not due', budget: null, next: '2026-10-30' },
    }),
    lot({
      id: 'l4',
      label: 'Lot 4',
      next: '2026-11-06',
      last_orders: { status: 'not due', budget: null, next: '2026-11-06' },
    }),
  ],
  total_value: 34435.4,
  unpriced: 0,
  not_in_a_lot: [
    {
      symbol: 'ACMESOLAR',
      delta: 30,
      close: 371.85,
      close_day: '2026-10-23',
      value: 11155.5,
      planned: [{ lot: 'Lot 2', shares: 30 }],
    },
    {
      symbol: 'GRWRHITECH',
      delta: 2,
      close: 7034,
      close_day: '2026-10-23',
      value: 14068,
      planned: [{ lot: 'Lot 2', shares: 1 }],
    },
    {
      symbol: 'NAZARA',
      delta: 0,
      close: 402.15,
      close_day: '2026-10-23',
      value: 0,
      planned: [{ lot: 'Lot 2', shares: 24 }],
    },
  ],
  not_in_a_lot_value: 25223.5,
  not_in_a_lot_unpriced: 0,
  last_orders: {
    week: '2026-10-23',
    created_at: '2026-10-23T14:25:44+05:30',
    trigger: 'scheduled',
    free_cash: 50000,
    deposit_needed: 0,
    lot_size: 50000,
  },
};

function row(label: string): HTMLElement {
  const tr = screen.getAllByText(label, { selector: 'td, td > span' })[0]?.closest('tr');
  if (!tr) throw new Error(`no row for ${label}`);
  return tr as HTMLElement;
}

describe('LotsPanel', () => {
  it('reads the read-only lots endpoint', () => {
    response = LIVE;
    render(<LotsPanel />);
    expect(calls).toContain('/api/momentum/lots');
  });

  it('shows each lot as `mbt lots show` and the Friday Telegram do', () => {
    response = LIVE;
    render(<LotsPanel />);
    const one = within(row('Lot 1'));
    expect(one.getByText('CUPID 28 · GRWRHITECH 1 · NAZARA 24 · RATEGAIN 12')).toBeTruthy();
    expect(one.getByText('₹34,435')).toBeTruthy();
    expect(one.getByText('Fri 16 Oct')).toBeTruthy();
    expect(one.getByText('Fri 13 Nov')).toBeTruthy();
    const two = within(row('Lot 2'));
    expect(two.getByText(/New lot: buy · ₹50,000/)).toBeTruthy();
    expect(two.getByText(/nothing booked yet/)).toBeTruthy();
    expect(two.getByText('last orders were for it')).toBeTruthy();
    expect(within(row('Lot 3')).getByText('Due Fri 30 Oct')).toBeTruthy();
    expect(within(row('Lot 4')).getByText('Not started')).toBeTruthy();
  });

  it('lists Kite beyond the lots beside what the orders said, flagging a difference', () => {
    response = LIVE;
    render(<LotsPanel />);
    expect(screen.getByText('Kite minus the lots')).toBeTruthy();
    expect(within(row('ACMESOLAR')).getByText('Lot 2: buy 30')).toBeTruthy();
    expect(
      within(row('GRWRHITECH')).getByText('Lot 2: buy 1 · 1 more than the orders said'),
    ).toBeTruthy();
    expect(within(row('ACMESOLAR')).getByText('+30')).toBeTruthy();
  });

  it('lists a trade the orders named that Kite does not show yet', () => {
    response = LIVE;
    render(<LotsPanel />);
    const nazara = within(row('NAZARA'));
    expect(nazara.getByText('0')).toBeTruthy();
    expect(nazara.getByText('Lot 2: buy 24 · not traded in Kite yet')).toBeTruthy();
  });

  it('heads the due column with the Friday and says when the page shows another week', () => {
    response = LIVE;
    render(<LotsPanel shownWeek="2026-10-16" />);
    expect(screen.getByText('Fri 30 Oct', { selector: 'th' })).toBeTruthy();
    expect(
      screen.getByText(/as they stand now, for Fri 30 Oct, not the week of Fri 16 Oct/),
    ).toBeTruthy();
  });

  it('marks a Kite snapshot that was not read today', () => {
    response = { ...LIVE, snapshot: { ...LIVE.snapshot!, today: false } };
    render(<LotsPanel />);
    expect(screen.getByText(/Kite · last read/)).toBeTruthy();
  });

  it('reads the ledger again when Your orders change', () => {
    response = LIVE;
    const { rerender } = render(<LotsPanel ordersVersion={0} />);
    expect(refetches).toBe(0);
    rerender(<LotsPanel ordersVersion={1} />);
    expect(refetches).toBe(1);
  });

  it('is left out when the headline is not followed lot by lot', () => {
    response = {
      available: false,
      reason: 'The headline favourite is not a group of sleeves.',
      week: '2026-10-30',
    };
    const { container } = render(<LotsPanel />);
    expect(container.textContent).toBe('');
  });

  it('shows an error with the data it already has', () => {
    response = LIVE;
    error = 'HTTP 502';
    render(<LotsPanel />);
    expect(screen.getByText(/Could not load the lots: HTTP 502/)).toBeTruthy();
    expect(screen.getByText('Lot 1', { selector: 'span' })).toBeTruthy();
  });
});
