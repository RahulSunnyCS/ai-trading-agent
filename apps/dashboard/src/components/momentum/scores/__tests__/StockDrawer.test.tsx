// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPolledResourceCache } from '../../../../hooks/usePolledResource';
import { DEFAULT_BUY_ZONE, type StockScore } from '../../../../lib/momentumScores';
import { StockDrawer } from '../StockDrawer';

const LOOKBACKS = [1, 2, 4, 8, 13, 26, 52];

function stock(symbol: string, over: Partial<StockScore> = {}): StockScore {
  return {
    symbol,
    company_name: `${symbol} Ltd.`,
    parent_group: 'Financials',
    subgroup: 'PSU Banks',
    last_price: 205.09,
    change_1w_pct: -0.0216,
    returns: { '13': 0.479, '26': 0.586 },
    scores: Object.fromEntries(LOOKBACKS.map((w) => [String(w), 90])),
    composite_rank: 27,
    composite_rank_prev: 89,
    high_52w_gap: -0.101,
    above_ma40: 0.321,
    volatility_52w: 0.64,
    up_weeks_26: 0.5,
    ...over,
  };
}

const detail = {
  symbol: 'AAA',
  weeks: Array.from({ length: 53 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}`),
  closes: Array.from({ length: 53 }, (_, i) => 100 + i),
  ma40: Array.from({ length: 53 }, (_, i) => (i < 39 ? null : 110 + i / 2)),
  score_weeks: Array.from({ length: 12 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`),
  scores: Object.fromEntries(
    LOOKBACKS.map((w) => [String(w), Array.from({ length: 12 }, (_, i) => 50 + i * 4)]),
  ),
  rank_weeks: Array.from(
    { length: 26 },
    (_, i) => `2026-04-${String((i % 28) + 1).padStart(2, '0')}`,
  ),
  ranks: Array.from({ length: 26 }, (_, i) => 200 - i * 6),
};

const circuits = {
  symbol: 'AAA',
  since: '2025-10-03',
  until: '2026-10-02',
  weeks: 52,
  sessions: 248,
  min_days: 3,
  total: 2,
  locks: [
    {
      direction: 'UC',
      start: '2026-09-28',
      end: '2026-10-02',
      days: 5,
      band_pct: 10,
      move_pct: 61.5,
      ongoing: true,
    },
    {
      direction: 'LC',
      start: '2026-03-10',
      end: '2026-03-12',
      days: 3,
      band_pct: 5,
      move_pct: -14.3,
      ongoing: false,
    },
  ],
};

/** Answers each endpoint with its own body; `over` swaps one for another response. */
function answer(over: { circuits?: () => Response } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/circuits'))
      return over.circuits ? over.circuits() : new Response(JSON.stringify(circuits));
    return new Response(JSON.stringify(detail), { status: 200 });
  });
}

function setup(over: Partial<Parameters<typeof StockDrawer>[0]> = {}) {
  const calls = { open: vi.fn(), close: vi.fn(), sector: vi.fn(), backtest: vi.fn() };
  render(
    <StockDrawer
      symbol="AAA"
      stocks={[stock('AAA'), stock('BBB'), stock('CCC')]}
      order={['AAA', 'BBB', 'CCC']}
      lookbacks={LOOKBACKS}
      zone={DEFAULT_BUY_ZONE}
      marks={new Map([['AAA', 'held' as const]])}
      onOpen={calls.open}
      onClose={calls.close}
      onSector={calls.sector}
      onBacktest={calls.backtest}
      {...over}
    />,
  );
  return calls;
}

describe('StockDrawer', () => {
  beforeEach(() => {
    clearPolledResourceCache();
    vi.stubGlobal('fetch', answer());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the stock's figures at once and its history once fetched", async () => {
    setup();
    expect(screen.getByRole('dialog', { name: /AAA/ })).toBeTruthy();
    expect(screen.getByText('Held')).toBeTruthy();
    expect(screen.getByText('₹205.09')).toBeTruthy();
    expect(screen.getByText(/-2\.16%/)).toBeTruthy();
    expect(screen.getByText('▲62')).toBeTruthy();
    expect(screen.getByText('+47.9%')).toBeTruthy();
    expect(screen.getByText('1 of 3')).toBeTruthy(); // its rank among the three PSU banks
    await act(async () => {});
    expect(screen.getByRole('img', { name: /Weekly closes over the last year/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Score deciles of each lookback/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Composite rank over the last 26 weeks/ })).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/momentum/scores/stock/AAA'),
      expect.anything(),
    );
  });

  it('steps to the neighbours in the list it was opened from', async () => {
    const calls = setup({ symbol: 'BBB' });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '← Prev' }));
    expect(calls.open).toHaveBeenLastCalledWith('AAA');
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    expect(calls.open).toHaveBeenLastCalledWith('CCC');
  });

  it('has no previous at the top of the list and no next at the bottom', async () => {
    setup({ symbol: 'AAA' });
    await act(async () => {});
    expect((screen.getByRole('button', { name: '← Prev' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    cleanup();
    setup({ symbol: 'CCC' });
    await act(async () => {});
    expect((screen.getByRole('button', { name: 'Next →' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('opens its sector and the backtest, and closes', async () => {
    const calls = setup();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Open its sector' }));
    expect(calls.sector).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAA' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in backtest' }));
    expect(calls.backtest).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close stock' }));
    expect(calls.close).toHaveBeenCalled();
  });

  it('says so for a symbol that is not scored this week', () => {
    setup({ symbol: 'ZZZ' });
    expect(screen.getByText('ZZZ is not scored this week')).toBeTruthy();
  });

  it('offers a retry when the history fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    setup();
    await act(async () => {});
    expect(screen.getByText("Couldn't load this stock's history")).toBeTruthy();
    // one retry for the history and one for the circuit locks, which fail on their own
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2);
  });

  it('is closed with no symbol', () => {
    setup({ symbol: null });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  describe('circuit locks', () => {
    it('lists the locks of the last 52 weeks, newest first, with the ongoing one flagged', async () => {
      setup();
      await act(async () => {});
      const section = screen.getByRole('heading', { name: /Circuit locks/ }).closest('section');
      expect(section).toBeTruthy();
      const rows = within(section as HTMLElement).getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      expect(within(rows[0] as HTMLElement).getByText('Upper')).toBeTruthy();
      expect(within(rows[0] as HTMLElement).getByText('Ongoing')).toBeTruthy();
      expect(within(rows[0] as HTMLElement).getByText(/5 sessions/)).toBeTruthy();
      expect(within(rows[0] as HTMLElement).getByText('+61.5%')).toBeTruthy();
      expect(within(rows[1] as HTMLElement).getByText('Lower')).toBeTruthy();
      expect(within(rows[1] as HTMLElement).getByText('-14.3%')).toBeTruthy();
      expect(within(rows[1] as HTMLElement).queryByText('Ongoing')).toBeNull();
      expect(within(section as HTMLElement).getByText(/1 lower, 1 upper/)).toBeTruthy();
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/momentum/scores/stock/AAA/circuits'),
        expect.anything(),
      );
    });

    it('says how many exist when only the latest are listed', async () => {
      vi.stubGlobal(
        'fetch',
        answer({
          circuits: () => new Response(JSON.stringify({ ...circuits, total: 15 })),
        }),
      );
      setup();
      await act(async () => {});
      expect(screen.getByText(/the latest 2 listed/)).toBeTruthy();
    });

    it('says plainly when there were none', async () => {
      vi.stubGlobal(
        'fetch',
        answer({
          circuits: () => new Response(JSON.stringify({ ...circuits, total: 0, locks: [] })),
        }),
      );
      setup();
      await act(async () => {});
      expect(screen.getByText(/No run of 3 or more sessions/)).toBeTruthy();
      expect(screen.getByText(/in the 248 sessions checked/)).toBeTruthy();
    });

    it('offers a retry of its own without hiding the rest of the drawer', async () => {
      vi.stubGlobal('fetch', answer({ circuits: () => new Response('boom', { status: 500 }) }));
      setup();
      await act(async () => {});
      expect(screen.getByText("Couldn't load the circuit locks")).toBeTruthy();
      expect(screen.getByRole('img', { name: /Weekly closes over the last year/ })).toBeTruthy();
      expect(screen.getByText('+47.9%')).toBeTruthy();
    });

    it('is not fetched while the drawer is closed', async () => {
      setup({ symbol: null });
      await act(async () => {});
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
