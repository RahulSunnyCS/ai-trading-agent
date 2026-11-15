import { describe, expect, it } from 'vitest';

import type { OverlayResult, OverlayTrade } from '../../types/optionsOverlay';
import {
  DEFAULT_REQUEST,
  buyText,
  countRows,
  requestChips,
  requestProblem,
  sellText,
  tradeText,
  tradesByDay,
} from '../optionsOverlay';

describe('options overlay helpers', () => {
  it('needs a strategy only where calls are bought on its picks', () => {
    expect(requestProblem({ ...DEFAULT_REQUEST, direction: 'calls' })).toMatch(/strategy/);
    expect(requestProblem({ ...DEFAULT_REQUEST, direction: 'puts' })).toBeNull();
    expect(requestProblem({ ...DEFAULT_REQUEST, direction: 'mirror' })).toBeNull();
    expect(
      requestProblem({ ...DEFAULT_REQUEST, direction: 'puts', sizing: 'capital_share' }),
    ).toMatch(/share of capital/);
  });

  it('says what the next run tests in chips', () => {
    const chips = requestChips(
      { ...DEFAULT_REQUEST, direction: 'switch', favourite_id: 'x' },
      'Trio',
    );
    expect(chips[0]).toBe('Trio');
    expect(chips).toContain('Market switch');
    expect(chips).toContain('NIFTY below its 200-day average');
    expect(requestChips({ ...DEFAULT_REQUEST, direction: 'mirror' }, null)).not.toContain(
      'No strategy',
    );
  });

  it('lists the skip counts largest first without zeros or the total', () => {
    const rows = countRows({ entries: 100, thin: 3, banned: 0, restruck: 7 });
    expect(rows.map((r) => r.value)).toEqual([7, 3]);
  });
});

describe('trade wording', () => {
  const trade = (o: Partial<OverlayTrade>): OverlayTrade =>
    ({
      entry: '2024-01-05',
      exit: '2024-01-12',
      symbol: 'LAURUSLABS',
      right: 'CE',
      strike: 2000,
      lots: 1,
      p0: 34,
      p1: 52,
      exit_how: 'same',
      pnl: 1500,
      ...o,
    }) as OverlayTrade;

  it('reads as a buy and a sell', () => {
    expect(tradeText(trade({}))).toBe('Buy LAURUSLABS 2,000 CE at 34.00 → Sell at 52.00');
    expect(buyText(trade({ right: 'PE', strike: 97.5, lots: 2 }))).toBe(
      'Buy LAURUSLABS 97.5 PE ×2 at 34.00',
    );
    expect(sellText(trade({ exit_how: 'zero' }))).toBe('Contract gone: booked at 0');
  });

  it("lists each day's sales and buys, puts first, nothing on a quiet day", () => {
    const result = {
      series: { days: ['2024-01-05', '2024-01-12', '2024-01-19'] },
      trades: [
        trade({ symbol: 'TCS', right: 'PE', p0: 20 }),
        trade({ symbol: 'PFC', strike: 400, p0: 10, p1: 5, pnl: -500 }),
      ],
    } as unknown as OverlayResult;
    const [first, second, third] = tradesByDay(result);
    expect(first).toBe('Bought 2:\n· Buy TCS 2,000 PE at 20.00\n· Buy PFC 400 CE at 10.00');
    expect(second?.split('\n')[0]).toMatch(/^Sold 2 \(/);
    expect(second).toContain('· PFC 400 CE: Sell at 5.00');
    expect(third).toBe('');
  });
});
