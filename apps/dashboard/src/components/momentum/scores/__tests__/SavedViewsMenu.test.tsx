// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_BUY_ZONE, type StockScore } from '../../../../lib/momentumScores';
import { useMomentumScoresStore } from '../../../../store/momentumScores';
import { useMomentumScoresViewsStore } from '../../../../store/momentumScoresViews';
import { StocksLeaderboard } from '../StocksLeaderboard';

const LOOKBACKS = [1, 2, 4, 8, 13, 26, 52];

function stock(i: number, over: Partial<StockScore> = {}): StockScore {
  return {
    symbol: `S${String(i).padStart(3, '0')}`,
    company_name: `Company ${i}`,
    parent_group: i % 2 ? 'Financials' : 'Healthcare',
    subgroup: i % 2 ? 'Banks' : 'Pharma',
    last_price: 100 + i,
    change_1w_pct: 0.01,
    returns: {},
    scores: Object.fromEntries(LOOKBACKS.map((w) => [String(w), 50])),
    composite_rank: i,
    ...over,
  };
}

// 1 and 3 are leaders in Financials; 2 is a laggard in Healthcare; 4 is a plain Healthcare name.
const STOCKS = [
  stock(1, { scores: { '4': 95, '13': 95, '26': 95 } }),
  stock(2, { scores: { '4': 5, '13': 5, '26': 5 } }),
  stock(3, { scores: { '4': 95, '13': 95, '26': 95 } }),
  stock(4),
];

function renderBoard() {
  return render(
    <StocksLeaderboard
      stocks={STOCKS}
      lookbacks={LOOKBACKS}
      zone={DEFAULT_BUY_ZONE}
      marks={undefined}
      scoredCount={STOCKS.length}
      savedViews
    />,
  );
}

const symbols = () =>
  within(screen.getAllByRole('rowgroup')[1] as HTMLElement)
    .getAllByRole('row')
    .map((row) => within(row).getByText(/^S\d{3}$/).textContent);

/** Radix opens a menu on a primary-button pointerdown. */
function openViews(): void {
  const trigger = screen.getByRole('button', { name: 'Saved views' });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

async function save(name: string): Promise<void> {
  openViews();
  await act(async () => {});
  fireEvent.click(await screen.findByRole('menuitem', { name: /Save current view/ }));
  await act(async () => {});
  fireEvent.change(screen.getByRole('textbox', { name: 'Name for this view' }), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await act(async () => {});
}

describe('saved views of the Stocks list', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMomentumScoresStore.setState({ hidden: new Set() });
    useMomentumScoresViewsStore.setState({ views: [], stripHelpOpen: true });
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('opens on All with a saved view in the browser, until one is picked', () => {
    useMomentumScoresViewsStore.getState().saveView('Leaders', {
      view: 'leaders',
      group: '',
      query: '',
      sort: { key: 'rank', lookback: null, ascending: true },
    });
    renderBoard();
    expect(symbols()).toEqual(['S001', 'S002', 'S003', 'S004']);
    expect(screen.getByRole('radio', { name: /^All/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('saves the current quick view, sector, search and sort under a name', async () => {
    renderBoard();
    fireEvent.click(screen.getByRole('radio', { name: /Leaders/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Sector group' }), {
      target: { value: 'Financials' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sort by the 13-week score' }));
    await save('Bank leaders');
    expect(useMomentumScoresViewsStore.getState().views).toEqual([
      {
        name: 'Bank leaders',
        settings: {
          view: 'leaders',
          group: 'Financials',
          query: '',
          sort: { key: 'score', lookback: 13, ascending: false },
        },
      },
    ]);
    // the naming field closes once saved
    expect(screen.queryByRole('textbox', { name: 'Name for this view' })).toBeNull();
  });

  it('applies a saved view, and goes back to the default from the menu', async () => {
    useMomentumScoresViewsStore.getState().saveView('Healthy', {
      view: 'all',
      group: 'Healthcare',
      query: '',
      sort: { key: 'rank', lookback: null, ascending: false },
    });
    renderBoard();
    openViews();
    await act(async () => {});
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Healthy/ }));
    await act(async () => {});
    expect(symbols()).toEqual(['S004', 'S002']); // Healthcare only, weakest rank first
    expect(
      (screen.getByRole('combobox', { name: 'Sector group' }) as HTMLSelectElement).value,
    ).toBe('Healthcare');

    openViews();
    await act(async () => {});
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /All stocks/ }));
    await act(async () => {});
    expect(symbols()).toEqual(['S001', 'S002', 'S003', 'S004']);
  });

  it('applies a view whose sector no longer exists as all sectors', async () => {
    useMomentumScoresViewsStore.getState().saveView('Gone', {
      view: 'leaders',
      group: 'Defunct Sector',
      query: '',
      sort: { key: 'rank', lookback: null, ascending: true },
    });
    renderBoard();
    openViews();
    await act(async () => {});
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Gone/ }));
    await act(async () => {});
    expect(symbols()).toEqual(['S001', 'S003']); // the leaders, not an empty list
  });

  it('deletes a view from the Delete submenu', async () => {
    useMomentumScoresViewsStore.getState().saveView('Old', {
      view: 'all',
      group: '',
      query: 'x',
      sort: { key: 'rank', lookback: null, ascending: true },
    });
    renderBoard();
    openViews();
    await act(async () => {});
    const trigger = await screen.findByRole('menuitem', { name: /Delete a view/ });
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
    await act(async () => {});
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete Old' }));
    await act(async () => {});
    expect(useMomentumScoresViewsStore.getState().views).toEqual([]);
  });

  it('refuses an empty name and keeps the field open', async () => {
    renderBoard();
    await save('   ');
    expect(screen.getByRole('alert').textContent).toMatch(/Give the view a name/);
    expect(useMomentumScoresViewsStore.getState().views).toEqual([]);
  });

  it('shows no Views menu where saved views are not wanted', () => {
    render(
      <StocksLeaderboard
        stocks={STOCKS}
        lookbacks={LOOKBACKS}
        zone={DEFAULT_BUY_ZONE}
        marks={undefined}
        scoredCount={STOCKS.length}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Saved views' })).toBeNull();
  });
});
