import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_BUY_ZONE, type StockScore } from '../../../../lib/momentumScores';
import { useMomentumScoresStore } from '../../../../store/momentumScores';
import { StocksLeaderboard } from '../StocksLeaderboard';

const LOOKBACKS = [1, 2, 4, 8, 13, 26, 52];

function stock(i: number, over: Partial<StockScore> = {}): StockScore {
  const score = (offset: number): number => Math.max(0, 99 - i * 0.5 - offset);
  return {
    symbol: `S${String(i).padStart(3, '0')}`,
    company_name: `Company ${i}`,
    parent_group: i % 2 ? 'Financials' : 'Healthcare',
    subgroup: i % 2 ? 'Banks' : 'Pharma',
    last_price: 100 + i,
    change_1w_pct: 0.01,
    returns: Object.fromEntries(LOOKBACKS.map((w) => [String(w), 0.1])),
    scores: Object.fromEntries(LOOKBACKS.map((w) => [String(w), score(w / 10)])),
    composite_rank: i,
    composite_rank_prev: i + 2,
    high_52w_gap: -0.03,
    spark: Array.from({ length: 26 }, (_, k) => 100 + k),
    ...over,
  };
}

const STOCKS = Array.from({ length: 250 }, (_, k) => stock(k + 1));

function renderBoard(stocks: StockScore[] = STOCKS) {
  return render(
    <StocksLeaderboard
      stocks={stocks}
      lookbacks={LOOKBACKS}
      zone={DEFAULT_BUY_ZONE}
      marks={new Map([['S003', 'held' as const]])}
      scoredCount={stocks.length}
    />,
  );
}

const bodyRows = () =>
  within(screen.getAllByRole('rowgroup')[1] as HTMLElement).getAllByRole('row');

describe('StocksLeaderboard', () => {
  beforeEach(() => useMomentumScoresStore.setState({ hidden: new Set() }));
  afterEach(cleanup);

  it('draws one page, strongest first, and adds a page at a time', () => {
    renderBoard();
    expect(bodyRows()).toHaveLength(100);
    expect(within(bodyRows()[0] as HTMLElement).getByText('S001')).toBeTruthy();
    expect(screen.getByText('Showing 100 of 250')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show 100 more' }));
    expect(bodyRows()).toHaveLength(200);
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
    expect(bodyRows()).toHaveLength(250);
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
  });

  it('searches by symbol, company or sector and starts again from the first page', async () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Show 100 more' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search stocks' }), {
      target: { value: 'company 17' },
    });
    await act(async () => {});
    // "Company 17", "Company 170".."Company 179"
    expect(bodyRows()).toHaveLength(11);
    expect(screen.getByText('Showing 11 of 11')).toBeTruthy();
  });

  it('marks held names and shows the rank change', () => {
    renderBoard();
    const row = bodyRows()[2] as HTMLElement; // S003
    expect(within(row).getByText('Held')).toBeTruthy();
    expect(within(row).getByText('▲2')).toBeTruthy();
  });

  it('filters by a quick view and counts it on the chip', () => {
    const stocks = [
      stock(1, { scores: { '4': 95, '13': 95, '26': 95 } }), // leader
      stock(2, { scores: { '4': 5, '13': 5, '26': 5 } }), // laggard
    ];
    renderBoard(stocks);
    fireEvent.click(screen.getByRole('radio', { name: /Leaders/ }));
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText('Showing 1 of 1')).toBeTruthy();
  });

  it('sorts by a lookback when its label in the strip header is clicked', () => {
    const stocks = [
      stock(1, { scores: { '13': 20, '4': 20, '26': 20 } }),
      stock(2, { scores: { '13': 80, '4': 80, '26': 80 } }),
    ];
    renderBoard(stocks);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by the 13-week score' }));
    expect(within(bodyRows()[0] as HTMLElement).getByText('S002')).toBeTruthy();
  });

  it('hides a column from the Columns menu choice', () => {
    renderBoard([stock(1)]);
    expect(screen.getAllByText('52w high').length).toBeGreaterThan(0);
    act(() => useMomentumScoresStore.getState().setColumnShown('high', false));
    expect(screen.queryByText('52w high')).toBeNull();
  });

  it('jumps to the search box on "/"', () => {
    renderBoard([stock(1)]);
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search stocks' }));
  });

  it('says so when nothing matches', async () => {
    renderBoard([stock(1)]);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search stocks' }), {
      target: { value: 'zzz' },
    });
    await act(async () => {});
    expect(screen.getByText('No stocks match.')).toBeTruthy();
  });

  it('survives a parent that keeps the reported order in state and rebuilds the list every render', async () => {
    function Host() {
      const [order, setOrder] = useState<string[]>([]);
      return (
        <>
          <output data-testid="order">{order.length}</output>
          <StocksLeaderboard
            stocks={STOCKS.map((s) => s)}
            lookbacks={LOOKBACKS}
            zone={DEFAULT_BUY_ZONE}
            marks={undefined}
            scoredCount={STOCKS.length}
            onOrder={setOrder}
          />
        </>
      );
    }
    render(<Host />);
    await act(async () => {});
    expect(screen.getByTestId('order').textContent).toBe('250');
  });

  it('opens a stock when its row is clicked, and a sector from its own link', () => {
    const opened: string[] = [];
    const sectors: string[] = [];
    render(
      <StocksLeaderboard
        stocks={[stock(1)]}
        lookbacks={LOOKBACKS}
        zone={DEFAULT_BUY_ZONE}
        marks={undefined}
        scoredCount={1}
        onOpenStock={(symbol) => opened.push(symbol)}
        onSector={(s) => sectors.push(s.subgroup)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Banks' }));
    expect(sectors).toEqual(['Banks']);
    expect(opened).toEqual([]); // the sector link does not also open the stock
    fireEvent.click(bodyRows()[0] as HTMLElement);
    expect(opened).toEqual(['S001']);
  });

  it('shows only the strongest few, with a link to the whole list, in the top variant', () => {
    const all: number[] = [];
    render(
      <StocksLeaderboard
        stocks={STOCKS}
        lookbacks={LOOKBACKS}
        zone={DEFAULT_BUY_ZONE}
        marks={undefined}
        scoredCount={STOCKS.length}
        heading="Strongest stocks right now"
        top={{ limit: 10, onShowAll: () => all.push(1) }}
      />,
    );
    expect(bodyRows()).toHaveLength(10);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /All 250 stocks/ }));
    expect(all).toHaveLength(1);
  });

  it('shows a removable filter chip', () => {
    const cleared: number[] = [];
    render(
      <StocksLeaderboard
        stocks={[stock(1)]}
        lookbacks={LOOKBACKS}
        zone={DEFAULT_BUY_ZONE}
        marks={undefined}
        scoredCount={1}
        heading="Stocks in Financials"
        chip={{ label: 'Sub-sector: PSU Banks', onClear: () => cleared.push(1) }}
        showGroupFilter={false}
      />,
    );
    expect(screen.queryByRole('combobox', { name: 'Sector group' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove the Sub-sector: PSU Banks filter' }),
    );
    expect(cleared).toHaveLength(1);
  });
});
