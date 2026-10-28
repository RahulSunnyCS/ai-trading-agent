// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ForwardView } from '../../../types/momentumForward';

let response: ForwardView | null = null;

vi.mock('../../../hooks/usePolledResource', () => ({
  usePolledResource: () => ({ data: response, loading: false, error: null, refetch: () => {} }),
}));

const { MomentumForwardCards } = await import('../MomentumForwardCards');

afterEach(() => cleanup());

const figures = { ideal: null, achievable: null };

const view: ForwardView = {
  paper_start: '2026-10-16',
  fills_error: null,
  score: {
    computed_at: '2026-10-30T15:00:00+00:00',
    code_commit: 'abc',
    ranking_now: 'point-in-time ranking (BL-001 F6)',
    rerun: true,
    weeks: ['2026-10-16'],
    scored_weeks: ['2026-10-16'],
    groups: [
      {
        group_id: 'g',
        name: 'Four Sectors Monthly, No Tilt · all Fridays',
        week: '2026-10-16',
        members: 4,
        scored: 4,
        status: 'scored',
        live: { ideal: -0.0806, achievable: null },
        backtest: { recorded: -0.0799, now: -0.0959 },
        gap: {
          recorded: { ideal: -0.0007, achievable: null },
          now: { ideal: 0.0153, achievable: null },
        },
        benchmark: -0.0615,
        ranking: 'ranking before BL-001 F6',
      },
    ],
    items: [
      {
        config_id: 's1',
        name: 'Sleeve 1',
        dataset: 'broad',
        run_kind: 'final',
        week: '2026-10-16',
        next_week: '2026-10-23',
        entry_id: 18,
        recorded_at: '2026-10-16T14:31:21Z',
        corrections: [],
        status: 'mismatch',
        reason: "next week's portfolio differs",
        mismatches: ['NAZARA: recorded BUY but not held the week after'],
        live: { ...figures, cost: null },
        backtest: { recorded: null, recorded_note: null, now: null },
        gap: { recorded: figures, now: figures },
        benchmark: null,
        ranking: null,
        sleeve_value: 1.6,
      },
    ],
  },
  fills: {
    paper_start: '2026-10-16',
    computed_at: '2026-10-30T15:00:00+00:00',
    groups: [
      {
        group_id: 'g',
        name: 'Four Sectors Monthly, No Tilt · all Fridays',
        outside_lots: [
          {
            day: '2026-10-19',
            time: '09:59:56',
            symbol: 'EXAMPLE',
            side: 'buy',
            qty: 10,
            price: 100,
          },
        ],
        unmatched_claims: [],
        rebalances: [
          {
            lot: 'Lot 1',
            sleeve_id: 's4',
            week: '2026-10-16',
            next_session: '2026-10-19',
            first_week: true,
            new_lot: true,
            first_trade_day: '2026-10-19',
            entry_id: 18,
            recorded_at: '2026-10-16T14:31:21Z',
            budget: 50000,
            budget_from: 'the lot size',
            orders_at: null,
            plan_differs: [],
            booked_pending: false,
            slippage_bps: 15,
            totals: {
              bought: 40000,
              sold: 0,
              real_charges: 48,
              model_charges: 50,
              slippage_close_rs: -800,
              slippage_open_rs: -810,
              slippage_plan_rs: 0,
            },
            rows: [
              {
                symbol: 'Nasdaq 100',
                signal_action: 'BUY',
                target_weight: 0.25,
                model_shares: null,
                plan_shares: null,
                plan_price: null,
                side: 'buy',
                shares: null,
                shares_first_day: null,
                avg_first_day: null,
                shares_later: null,
                avg_later: null,
                difference: null,
                friday_close: null,
                next_open: null,
                vs_close_bps: null,
                vs_open_bps: null,
                vs_plan_bps: null,
                charges: null,
                model_charges: null,
                booked: [],
                days: [],
                note: null,
                status: 'missed',
              },
            ],
          },
        ],
      },
    ],
  },
};

describe('MomentumForwardCards', () => {
  it('says nothing is scored yet and no rebalance is reconciled before the first Friday job', () => {
    response = {
      score: null,
      fills: { paper_start: null, groups: [], computed_at: null },
      fills_error: null,
      paper_start: null,
    };
    render(<MomentumForwardCards />);
    expect(screen.getByText(/Nothing scored yet/)).toBeTruthy();
    expect(screen.getByText(/No real rebalance yet/)).toBeTruthy();
  });

  it('shows the group week beside both backtests and the lot reconciliation', () => {
    response = view;
    render(<MomentumForwardCards />);
    expect(screen.getByText('-8.06%')).toBeTruthy();
    expect(screen.getByText('-7.99%')).toBeTruthy();
    expect(screen.getByText('-9.59%')).toBeTruthy();
    expect(screen.getByText(/Lot 1 · week of/)).toBeTruthy();
    expect(screen.getByText('missed')).toBeTruthy();
    expect(screen.getByText(/Outside the lots/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Every favourite/ }));
    expect(screen.getByText('Mismatch')).toBeTruthy();
  });
});
