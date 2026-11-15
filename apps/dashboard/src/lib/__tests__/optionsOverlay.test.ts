import { describe, expect, it } from 'vitest';

import type { OverlayResult, OverlayTrade } from '../../types/optionsOverlay';
import {
  DEFAULT_REQUEST,
  boughtByDay,
  countRows,
  requestChips,
  requestProblem,
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

describe('boughtByDay', () => {
  it("lists each day's puts and calls, lots marked, nothing on a day without a buy", () => {
    const trade = (entry: string, symbol: string, right: 'CE' | 'PE', lots = 1) =>
      ({ entry, symbol, right, lots }) as OverlayTrade;
    const result = {
      series: { days: ['2024-01-05', '2024-01-12', '2024-01-19'] },
      trades: [
        trade('2024-01-05', 'TCS', 'PE'),
        trade('2024-01-05', 'INFY', 'PE', 2),
        trade('2024-01-05', 'PFC', 'CE'),
        trade('2024-01-12', 'REC', 'CE'),
      ],
    } as unknown as OverlayResult;
    expect(boughtByDay(result)).toEqual([
      'Puts (2): INFY ×2, TCS\nCalls (1): PFC',
      'Calls (1): REC',
      '',
    ]);
  });
});
