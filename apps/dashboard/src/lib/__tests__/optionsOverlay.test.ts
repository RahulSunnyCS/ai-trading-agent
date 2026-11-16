import { describe, expect, it } from 'vitest';

import type { OverlayResult, OverlayStart, OverlayTrade } from '../../types/optionsOverlay';
import { formatInr } from '../format';
import {
  DEFAULT_CUSTOM,
  DEFAULT_REQUEST,
  buyText,
  countRows,
  customName,
  requestChips,
  requestProblem,
  sellText,
  startHover,
  startOutcome,
  startsAxis,
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

describe('custom strategy', () => {
  it('names itself and needs look-backs and a sane exit rank', () => {
    expect(customName(DEFAULT_CUSTOM)).toBe('Custom · top 10 · 52w · weekly');
    const base = { ...DEFAULT_REQUEST, direction: 'calls' as const };
    expect(requestProblem({ ...base, custom: DEFAULT_CUSTOM })).toBeNull();
    expect(requestProblem({ ...base, custom: { ...DEFAULT_CUSTOM, lookbacks: [] } })).toMatch(
      /look-back/,
    );
    expect(
      requestProblem({ ...base, custom: { ...DEFAULT_CUSTOM, top_n: 10, exit_rank: 5 } }),
    ).toMatch(/exit rank/);
    expect(requestChips({ ...base, custom: DEFAULT_CUSTOM }, customName(DEFAULT_CUSTOM))[0]).toBe(
      'Custom · top 10 · 52w · weekly',
    );
  });
});

describe('fresh starts', () => {
  const start: OverlayStart = {
    start: '2024-07-01',
    first_day: '2024-07-05',
    last_day: '2025-06-27',
    end_rs: 15_000,
    taken_rs: 0,
    low_rs: 12_000,
    washed_out: true,
    max_dd: -0.9,
    trades: 41,
    unaffordable: 33,
  };

  it('calls a start above, washed out or neither', () => {
    expect(startOutcome(start, 100_000)).toBe('washed');
    expect(startOutcome({ ...start, washed_out: false }, 100_000)).toBe('below');
    expect(startOutcome({ ...start, end_rs: 391_817 }, 100_000)).toBe('above');
  });

  it('says what a start did in its tooltip', () => {
    const text = startHover(start);
    expect(text).toContain(`Ended ${formatInr(15_000, { compact: true })}`);
    expect(text).toContain('washed out');
    expect(text).toContain('41 trades · 33 picks it could not pay for');
    expect(startHover({ ...start, unaffordable: 0 })).not.toContain('could not pay');
  });

  it('puts the log ticks at multiples of the capital up to the best start', () => {
    const axis = startsAxis(100_000, 2_400_000);
    expect(axis.floor).toBe(1_000);
    expect(axis.tickvals).toEqual([
      1_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000,
    ]);
    expect(axis.ticktext[4]).toBe('₹1.00 L');
  });
});
