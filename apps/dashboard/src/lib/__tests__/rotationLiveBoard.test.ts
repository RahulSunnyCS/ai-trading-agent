import { describe, expect, it } from 'vitest';

import { refreshDone } from '../../hooks/useRotationLiveBoard';
import type { LiveBoardResponse, LiveBook, LivePick } from '../../types/rotationLiveBoard';
import {
  bookNet,
  chartLines,
  legExit,
  lotsLine,
  minuteToChartTime,
  pickNet,
  staleError,
  statusLine,
} from '../rotationLiveBoard';

const pick = (over: Partial<LivePick> = {}): LivePick => ({
  variant: 'N_wide_0947',
  label: 'N_widesl_OTM1',
  params: '',
  role: 'core',
  underlying: 'NIFTY',
  entry_time: '09:47',
  exit_time: '15:28',
  state: 'open',
  legs: [],
  gross: 1000,
  net: 1000,
  net_slipped: 800,
  worst_mtm: -200,
  stopped_by: null,
  curve: [
    [32, 0],
    [33, 50],
  ],
  lots: 2,
  ...over,
});

const book = (over: Partial<LiveBook> = {}): LiveBook => ({
  book: 't1',
  name: 'Adaptive Tuned',
  late: false,
  expiry_only: null,
  dte: null,
  accounts: ['algotest · finvasia ×1'],
  picks: [pick()],
  per_lot: { net: 1000, net_slipped: 800 },
  yours: { net: 2000, net_slipped: 1600, lots: 2 },
  curve: [
    [32, 0],
    [33, 50],
  ],
  curve_yours: [
    [32, 0],
    [33, 100],
  ],
  ...over,
});

const response = (over: Partial<LiveBoardResponse> = {}): LiveBoardResponse => ({
  today: '2026-11-03',
  snapshot: {
    v: 1,
    day: '2026-11-03',
    refreshed_at: '2026-11-03T15:15:19+05:30',
    as_of: '15:15',
    source: 'angelone',
    slippage_pct: 0.5,
    spot: {},
    books: [book()],
    notes: [],
  },
  state: {},
  loop: { running: true, every_s: 300, next_at: '2026-11-03T15:20:19+05:30' },
  ...over,
});

describe('live board view', () => {
  it('shows a lot each or your lots, with or without slippage', () => {
    expect(bookNet(book(), 'lot', false)).toBe(1000);
    expect(bookNet(book(), 'yours', true)).toBe(1600);
    expect(pickNet(pick(), 'yours', false)).toBe(2000);
    expect(pickNet(pick({ lots: 0 }), 'yours', false)).toBe(0);
    expect(pickNet(pick(), 'lot', true)).toBe(800);
  });

  it('says who trades a list, or that nobody does', () => {
    expect(lotsLine(book())).toBe('2 lots · algotest · finvasia ×1');
    expect(lotsLine(book({ accounts: [] }))).toMatch(/^Not traded/);
  });

  it('puts session minutes on an axis that reads IST', () => {
    const t = minuteToChartTime('2026-11-03', 32);
    expect(new Date(t * 1000).toISOString()).toBe('2026-11-03T09:47:00.000Z');
    const lines = chartLines(
      '2026-11-03',
      [book(), book({ name: 'Empty', curve: [], curve_yours: [] })],
      'yours',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.points.map((p) => p.value)).toEqual([0, 100]);
  });

  it('names the time of the prices and the next refresh', () => {
    const now = Date.parse('2026-11-03T15:16:00+05:30');
    expect(statusLine(response(), now)).toBe('Prices to 15:15, read at 15:15 · next at 15:20');
    const off = statusLine(response({ loop: { running: false } }), now);
    expect(off).toContain('not running');
    const old = response();
    if (old.snapshot) old.snapshot.day = '2026-11-02';
    expect(statusLine(old, now)).toContain('showing 2026-11-02');
  });

  it('shows an error only when it is newer than the last good refresh', () => {
    const err = { last_error: 'rate limit', last_error_at: '2026-11-03T15:10:00+05:30' };
    expect(
      staleError(response({ state: { ...err, last_ok_at: '2026-11-03T15:15:00+05:30' } })),
    ).toBeNull();
    expect(
      staleError(response({ state: { ...err, last_ok_at: '2026-11-03T15:05:00+05:30' } })),
    ).toBe('rate limit');
  });

  it('reads a leg as open, or its exit time and reason', () => {
    expect(legExit({ exit: null, reason: 'open' })).toBe('open');
    expect(legExit({ exit: '15:28', reason: 'EXIT_TIME' })).toBe('15:28 exit time');
    expect(legExit({ exit: '13:35', reason: 'SL' })).toBe('13:35 SL');
  });

  it('knows when the refresh it asked for has finished', () => {
    const asked = Date.parse('2026-11-03T15:15:00+05:30');
    expect(refreshDone(response({ state: { refreshing: true } }), asked)).toBe(false);
    expect(
      refreshDone(response({ state: { last_ok_at: '2026-11-03T15:10:00+05:30' } }), asked),
    ).toBe(false);
    expect(
      refreshDone(response({ state: { last_ok_at: '2026-11-03T15:16:00+05:30' } }), asked),
    ).toBe(true);
  });
});
