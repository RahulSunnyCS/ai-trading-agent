import { describe, expect, it } from 'vitest';

import type { DailyJob } from '../../types/legwise';
import type { MomentumWeeklyJob, MomentumWeeklyStatus } from '../../types/momentum';
import {
  FEED_STALE_AFTER_MS,
  countWeeklyActions,
  describeWeeklyActions,
  eveningJobLine,
  feedHealth,
  weeklyScheduleLine,
  weeklySignalRows,
  weeklySignalSummary,
} from '../overview';

const NOW = Date.parse('2026-10-05T06:00:00Z'); // Mon 11:30 IST

describe('feedHealth', () => {
  const base = {
    connection: 'connected' as const,
    lastTickAt: NOW - 1_000,
    now: NOW,
    marketOpen: true,
    simulate: false,
  };

  it('is live while ticks are fresh, up to and including the threshold', () => {
    expect(feedHealth(base)).toBe('live');
    expect(feedHealth({ ...base, lastTickAt: NOW - FEED_STALE_AFTER_MS })).toBe('live');
  });

  it('is stale once the last tick is older than the threshold in an open market', () => {
    expect(FEED_STALE_AFTER_MS).toBe(45_000);
    expect(feedHealth({ ...base, lastTickAt: NOW - FEED_STALE_AFTER_MS - 1 })).toBe('stale');
  });

  it('is idle, never stale, when the market is closed', () => {
    expect(feedHealth({ ...base, marketOpen: false, lastTickAt: NOW - 3_600_000 })).toBe('idle');
    expect(feedHealth({ ...base, marketOpen: false, lastTickAt: null })).toBe('idle');
  });

  it('still reports live when ticks arrive outside market hours', () => {
    expect(feedHealth({ ...base, marketOpen: false })).toBe('live');
  });

  it('expects ticks around the clock in simulation mode', () => {
    const sim = { ...base, marketOpen: false, simulate: true };
    expect(feedHealth({ ...sim, lastTickAt: NOW - 60_000 })).toBe('stale');
    expect(feedHealth({ ...sim, lastTickAt: null })).toBe('waiting');
  });

  it('is waiting when connected in an open market before the first tick', () => {
    expect(feedHealth({ ...base, lastTickAt: null })).toBe('waiting');
  });

  it('reports the socket state ahead of any tick age', () => {
    expect(feedHealth({ ...base, connection: 'disconnected' })).toBe('disconnected');
    expect(feedHealth({ ...base, connection: 'connecting', lastTickAt: null })).toBe('connecting');
    expect(feedHealth({ ...base, connection: 'disconnected', marketOpen: false })).toBe(
      'disconnected',
    );
  });
});

describe('weekly signal summary', () => {
  const rows = [
    { asset: 'GOLD', action: 'BUY' },
    { asset: 'IT', action: 'ADD 2%' },
    { asset: 'BANK', action: 'SELL' },
    { asset: 'AUTO', action: 'HOLD' },
    { asset: 'FMCG', action: 'AT CAP' },
    { asset: 'PHARMA', action: 'hold' },
    { asset: 'METAL', action: '' },
    { asset: 'ENERGY', action: 'WAIT' },
  ];

  it('counts buys, sells and holds, skipping blank and WAIT rows', () => {
    expect(countWeeklyActions(rows)).toEqual({ buys: 2, sells: 1, holds: 3 });
  });

  it('returns null when the payload has no signal rows', () => {
    expect(countWeeklyActions(null)).toBeNull();
    expect(countWeeklyActions(undefined)).toBeNull();
    expect(countWeeklyActions('rows')).toBeNull();
    expect(countWeeklyActions([])).toBeNull();
    expect(countWeeklyActions([{ asset: 'GOLD' }, 7, null])).toBeNull();
  });

  it('describes the counts, singular and plural, leaving out zeros', () => {
    expect(describeWeeklyActions({ buys: 2, sells: 1, holds: 3 })).toBe(
      '2 buys · 1 sell · 3 holds',
    );
    expect(describeWeeklyActions({ buys: 1, sells: 0, holds: 1 })).toBe('1 buy · 1 hold');
    expect(describeWeeklyActions({ buys: 0, sells: 0, holds: 0 })).toBe('No positions indicated');
  });

  it('puts the strategy first and falls back to the strategy alone without rows', () => {
    expect(weeklySignalSummary('ETF Weekly Core', rows)).toBe(
      'ETF Weekly Core · 2 buys · 1 sell · 3 holds',
    );
    expect(weeklySignalSummary('ETF Weekly Core', null)).toBe('ETF Weekly Core');
  });
});

describe('weeklySignalRows', () => {
  const rows = [{ asset: 'GOLD', action: 'BUY' }];
  function job(patch: Partial<MomentumWeeklyJob> = {}): MomentumWeeklyJob {
    return {
      id: 'j1',
      run: 'final',
      send: false,
      status: 'done',
      started_at: '2026-10-02T16:45:00+05:30',
      finished_at: '2026-10-02T16:46:00+05:30',
      error: null,
      result: {
        title: 't',
        body: 'b',
        severity: 'info',
        sent_to_telegram: false,
        signal: { week: '2026-10-02', rows: [{ asset: 'OWN', action: 'SELL' }] },
        strategies: [
          {
            id: 'a',
            name: 'Other',
            dataset: 'etf',
            active: false,
            blocked: null,
            title: null,
            body: null,
            signal: { week: '2026-10-02', rows: [] },
          },
          {
            id: 'b',
            name: 'Active',
            dataset: 'etf',
            active: true,
            blocked: null,
            title: null,
            body: null,
            signal: { week: '2026-10-02', rows },
          },
        ],
      },
      ...patch,
    };
  }

  it("returns the active strategy's rows for the same week", () => {
    expect(weeklySignalRows(job(), '2026-10-02')).toBe(rows);
  });

  it("uses the run's own signal when it lists no strategies", () => {
    const base = job();
    const result = { ...base.result, strategies: undefined } as unknown as NonNullable<
      MomentumWeeklyJob['result']
    >;
    expect(weeklySignalRows(job({ result }), '2026-10-02')).toEqual([
      { asset: 'OWN', action: 'SELL' },
    ]);
  });

  it('is null for another week, a preview, an unfinished run or no job', () => {
    expect(weeklySignalRows(job(), '2026-09-25')).toBeNull();
    expect(weeklySignalRows(job({ run: 'preview' }), '2026-10-02')).toBeNull();
    expect(weeklySignalRows(job({ status: 'running', result: null }), '2026-10-02')).toBeNull();
    expect(weeklySignalRows(job({ status: 'failed' }), '2026-10-02')).toBeNull();
    expect(weeklySignalRows(null, '2026-10-02')).toBeNull();
  });

  it('is null when the active strategy was blocked', () => {
    const base = job();
    const strategies = (base.result?.strategies ?? []).map((strategy) =>
      strategy.active ? { ...strategy, blocked: 'data not ready' } : strategy,
    );
    const result = { ...base.result, strategies } as NonNullable<MomentumWeeklyJob['result']>;
    expect(weeklySignalRows(job({ result }), '2026-10-02')).toBeNull();
  });
});

describe('weeklyScheduleLine', () => {
  const item = (
    run: MomentumWeeklyStatus['schedule'][number]['run'],
    when: string,
  ): MomentumWeeklyStatus['schedule'][number] => ({
    run,
    when,
    last_ran_at: null,
    last_line: null,
    ran_late_by_minutes: null,
  });

  it('lists the signal runs and leaves the data ingest out', () => {
    expect(
      weeklyScheduleLine([
        item('preview', 'Fri 14:40 IST'),
        item('final', 'Fri 16:45 IST'),
        item('stock-ingest', 'Fri 19:30 IST'),
      ]),
    ).toBe('Next runs: preview Fri 14:40 IST · final Fri 16:45 IST');
  });

  it('is null without a signal run', () => {
    expect(weeklyScheduleLine([])).toBeNull();
    expect(weeklyScheduleLine(undefined)).toBeNull();
    expect(
      weeklyScheduleLine([item('stock-ingest', 'Fri 19:30 IST'), item('final', ' ')]),
    ).toBeNull();
  });
});

describe('eveningJobLine', () => {
  const job = (patch: Partial<DailyJob>): DailyJob => ({
    state: 'idle',
    day: null,
    started: null,
    finished: null,
    log: [],
    ...patch,
  });

  it('says a run is in progress', () => {
    expect(
      eveningJobLine(job({ state: 'running', started: '2026-10-05T11:00:00+05:30' }), NOW),
    ).toBe('evening run in progress');
  });

  it('says when the last run finished or failed', () => {
    const finished = '2026-10-05T08:30:00+05:30'; // three hours before NOW
    expect(eveningJobLine(job({ state: 'done', finished }), NOW)).toBe('last run 3 h ago');
    expect(eveningJobLine(job({ state: 'failed', finished }), NOW)).toBe('last run failed 3 h ago');
  });

  it('says nothing has run when the service holds no finished job', () => {
    expect(eveningJobLine(job({}), NOW)).toBe('no evening run since the service started');
    expect(eveningJobLine(job({ state: 'done' }), NOW)).toBe(
      'no evening run since the service started',
    );
  });
});
