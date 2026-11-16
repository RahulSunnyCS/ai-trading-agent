import { describe, expect, it } from 'vitest';

import type { OverlayJob, OverlayResult, OverlayTrade } from '../../types/optionsOverlay';
import {
  DEFAULT_CUSTOM,
  DEFAULT_REQUEST,
  buyText,
  countRows,
  customName,
  jobRunning,
  parseSlippage,
  requestChips,
  requestProblem,
  sellText,
  slippageText,
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

describe('the run state and the slippage field', () => {
  const running = { id: 'a', status: 'running' } as OverlayJob;
  const done = { id: 'a', status: 'done' } as OverlayJob;

  it('stops waiting when a poll fails, even for a job last seen running', () => {
    const state = { starting: false, jobId: 'a', job: running, pollError: null };
    expect(jobRunning(state)).toBe(true);
    expect(jobRunning({ ...state, pollError: 'HTTP 404' })).toBe(false);
    expect(jobRunning({ ...state, job: null, pollError: 'HTTP 404' })).toBe(false);
    expect(jobRunning({ ...state, job: null })).toBe(true); // first answer not in yet
    expect(jobRunning({ ...state, job: done })).toBe(false);
    expect(jobRunning({ starting: true, jobId: null, job: null, pollError: null })).toBe(true);
    expect(jobRunning({ starting: false, jobId: null, job: null, pollError: null })).toBe(false);
  });

  it('shows a stored slippage as typed and reads what is typed as a fraction', () => {
    expect(slippageText(0.07)).toBe('7');
    expect(slippageText(0.29)).toBe('29');
    expect(slippageText(0.015)).toBe('1.5');
    expect(slippageText(null)).toBe('');
    expect(parseSlippage('7')).toBe(0.07);
    expect(parseSlippage('1.')).toBe(0.01); // mid-typing: the field keeps "1." itself
    expect(parseSlippage('1.5')).toBe(0.015);
    expect(parseSlippage('')).toBeNull();
    expect(parseSlippage('abc')).toBeNull();
    expect(parseSlippage('50')).toBeNull();
    expect(parseSlippage('-1')).toBeNull();
  });
});
