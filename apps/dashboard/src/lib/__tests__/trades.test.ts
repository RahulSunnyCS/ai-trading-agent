import { describe, expect, it } from 'vitest';

import type { PaperTrade, Personality } from '../../types/trading';
import {
  DEFAULT_TRADE_SORT,
  NO_PERSONALITY,
  TRADE_CSV_COLUMNS,
  type TradeFilters,
  UNASSIGNED_LABEL,
  csvIstDateTime,
  exitReasonLabel,
  filterTrades,
  formatHoldTime,
  hasActiveFilters,
  isRangeInverted,
  nextTradeSort,
  optionalColumns,
  parseDayParam,
  parseStatusFilter,
  pnlPctOfPremium,
  premiumCollected,
  sortTradeRows,
  toTradeRows,
  tradeCsvRows,
  tradeEntryDay,
  tradesCsvFilename,
} from '../trades';

function trade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: 't1',
    entry_time: '2026-09-28T04:00:00.000Z', // 09:30 IST
    exit_time: '2026-09-28T06:30:00.000Z', // 12:00 IST
    status: 'closed',
    straddle_at_entry: '200.00',
    entry_ce_price: '100',
    entry_pe_price: '100',
    gross_pnl: '650',
    net_pnl: '650',
    exit_reason: 'TARGET',
    lots: 1,
    lot_size: 65,
    ...overrides,
  };
}

function personality(overrides: Partial<Personality> = {}): Personality {
  return {
    id: 'p1',
    name: 'Clockwork',
    display_name: 'Clockwork',
    group_type: 'reference',
    entry_type: 'fixed_time',
    management_style: 'hold',
    is_frozen: true,
    is_active: true,
    phase: 1,
    params: {},
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const NO_FILTERS: TradeFilters = { status: 'all', personality: null, from: null, to: null };

describe('query-string parsing', () => {
  it('accepts the three statuses and falls back to all', () => {
    expect(parseStatusFilter('open')).toBe('open');
    expect(parseStatusFilter('closed')).toBe('closed');
    expect(parseStatusFilter('OPEN')).toBe('all');
    expect(parseStatusFilter(null)).toBe('all');
  });

  it('keeps only real calendar days', () => {
    expect(parseDayParam('2026-09-28')).toBe('2026-09-28');
    expect(parseDayParam('2026-02-30')).toBeNull();
    expect(parseDayParam('28-09-2026')).toBeNull();
    expect(parseDayParam('')).toBeNull();
    expect(parseDayParam(null)).toBeNull();
  });

  it('flags an inverted range and active filters', () => {
    expect(isRangeInverted({ from: '2026-09-30', to: '2026-09-28' })).toBe(true);
    expect(isRangeInverted({ from: '2026-09-28', to: '2026-09-28' })).toBe(false);
    expect(isRangeInverted({ from: null, to: '2026-09-28' })).toBe(false);
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...NO_FILTERS, to: '2026-09-28' })).toBe(true);
  });
});

describe('filterTrades', () => {
  const trades = [
    trade({ id: 'a', personality_id: 'p1' }),
    trade({
      id: 'b',
      personality_id: 'p2',
      status: 'open',
      exit_time: null,
      net_pnl: null,
      entry_time: '2026-09-29T04:00:00.000Z',
    }),
    trade({ id: 'c', personality_id: null, entry_time: '2026-09-30T04:00:00.000Z' }),
    // 23:00 IST on 30 Sep is 17:30 UTC the same day; 00:30 IST on 1 Oct is 19:00 UTC on 30 Sep.
    trade({ id: 'd', entry_time: '2026-09-30T19:00:00.000Z' }),
  ];
  const ids = (filters: Partial<TradeFilters>) =>
    filterTrades(trades, { ...NO_FILTERS, ...filters }).map((t) => t.id);

  it('returns everything with no filter', () => {
    expect(ids({})).toEqual(['a', 'b', 'c', 'd']);
  });

  it('filters by status', () => {
    expect(ids({ status: 'open' })).toEqual(['b']);
    expect(ids({ status: 'closed' })).toEqual(['a', 'c', 'd']);
  });

  it('filters by personality, including trades with none', () => {
    expect(ids({ personality: 'p1' })).toEqual(['a']);
    expect(ids({ personality: NO_PERSONALITY })).toEqual(['c', 'd']);
    expect(ids({ personality: 'missing' })).toEqual([]);
  });

  it('filters by the IST entry day, inclusive at both ends', () => {
    expect(ids({ from: '2026-09-29', to: '2026-09-30' })).toEqual(['b', 'c']);
    expect(ids({ from: '2026-10-01' })).toEqual(['d']);
    expect(ids({ to: '2026-09-28' })).toEqual(['a']);
    expect(tradeEntryDay(trades[3] as PaperTrade)).toBe('2026-10-01');
  });

  it('combines filters and matches nothing on an inverted range', () => {
    expect(ids({ status: 'closed', personality: NO_PERSONALITY, to: '2026-09-30' })).toEqual(['c']);
    expect(ids({ from: '2026-09-30', to: '2026-09-28' })).toEqual([]);
  });
});

describe('exitReasonLabel', () => {
  it('labels every reason the server writes', () => {
    expect(exitReasonLabel('TARGET')).toBe('Target hit');
    expect(exitReasonLabel('target')).toBe('Target hit');
    expect(exitReasonLabel('SL')).toBe('Stop-loss');
    expect(exitReasonLabel('stop_loss')).toBe('Stop-loss');
    expect(exitReasonLabel('TSL')).toBe('Trailing stop');
    expect(exitReasonLabel('time_exit')).toBe('Time exit');
    expect(exitReasonLabel('EOD')).toBe('End of day');
    expect(exitReasonLabel('EXIT_WINDOW')).toBe('Exit window');
    expect(exitReasonLabel('DAILY_LOSS')).toBe('Daily loss cap');
    expect(exitReasonLabel('ROLL')).toBe('Rolled');
    expect(exitReasonLabel('CUT')).toBe('Cut (re-enter)');
  });

  it('humanises an unknown code and blanks a missing one', () => {
    expect(exitReasonLabel('NEW_RULE_X')).toBe('New rule x');
    expect(exitReasonLabel(null)).toBe('');
    expect(exitReasonLabel('  ')).toBe('');
  });
});

describe('P&L % of premium collected', () => {
  it('is net ÷ (straddle × lots × lot size)', () => {
    const t = trade({ straddle_at_entry: '212.50', net_pnl: '900', lots: 2, lot_size: 65 });
    expect(premiumCollected(t)).toBeCloseTo(27_625);
    expect(pnlPctOfPremium(t)).toBeCloseTo(900 / 27_625);
  });

  it('is negative for a loss', () => {
    expect(pnlPctOfPremium(trade({ net_pnl: '-1300' }))).toBeCloseTo(-0.1);
  });

  it('is null when an input is missing or the premium is not positive', () => {
    expect(pnlPctOfPremium(trade({ net_pnl: null }))).toBeNull();
    expect(pnlPctOfPremium(trade({ straddle_at_entry: null }))).toBeNull();
    expect(pnlPctOfPremium(trade({ straddle_at_entry: '0' }))).toBeNull();
    expect(pnlPctOfPremium(trade({ lot_size: Number.NaN }))).toBeNull();
  });
});

describe('toTradeRows', () => {
  const people = [personality(), personality({ id: 'p2', name: 'precision', display_name: '' })];

  it('resolves names, durations, quantities and optional fields', () => {
    const [row] = toTradeRows(
      [
        trade({
          personality_id: 'p1',
          symbol: 'NIFTY',
          strike: '25000.00',
          vix_at_entry: '12.5',
          market_regime: 'RANGING',
        }),
      ],
      people,
    );
    expect(row?.personalityName).toBe('Clockwork');
    expect(row?.durationMs).toBe(150 * 60_000);
    expect(row?.quantity).toBe(65);
    expect(row?.strike).toBe(25_000);
    expect(row?.vixAtEntry).toBe(12.5);
    expect(row?.exitReasonLabel).toBe('Target hit');
  });

  it('falls back to name, then Unassigned', () => {
    const rows = toTradeRows(
      [
        trade({ personality_id: 'p2' }),
        trade({ personality_id: 'gone' }),
        trade({ personality_id: null }),
      ],
      people,
    );
    expect(rows.map((r) => r.personalityName)).toEqual([
      'precision',
      UNASSIGNED_LABEL,
      UNASSIGNED_LABEL,
    ]);
  });

  it('has no duration while open', () => {
    const [row] = toTradeRows([trade({ status: 'open', exit_time: null })], people);
    expect(row?.durationMs).toBeNull();
  });

  it('reports which optional columns have data', () => {
    expect(optionalColumns(toTradeRows([trade()], people))).toEqual({
      contract: false,
      regime: false,
      vix: false,
    });
    expect(optionalColumns(toTradeRows([trade(), trade({ vix_at_entry: '13' })], people)).vix).toBe(
      true,
    );
  });
});

describe('formatHoldTime', () => {
  it('uses formatDuration under an hour and hours + minutes above', () => {
    expect(formatHoldTime(37_000)).toBe('37s');
    expect(formatHoldTime(12 * 60_000 + 5_000)).toBe('12m 05s');
    expect(formatHoldTime(150 * 60_000)).toBe('2h 30m');
    expect(formatHoldTime(null)).toBe('—');
  });
});

describe('sorting', () => {
  const rows = toTradeRows(
    [
      trade({ id: 'a', net_pnl: '100', entry_time: '2026-09-28T04:00:00.000Z' }),
      trade({
        id: 'b',
        net_pnl: null,
        status: 'open',
        exit_time: null,
        entry_time: '2026-09-30T04:00:00.000Z',
      }),
      trade({ id: 'c', net_pnl: '-50', entry_time: '2026-09-29T04:00:00.000Z' }),
    ],
    [],
  );

  it('defaults to newest entry first', () => {
    expect(sortTradeRows(rows, DEFAULT_TRADE_SORT).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('puts missing values last in both directions', () => {
    expect(sortTradeRows(rows, { key: 'net', dir: 'desc' }).map((r) => r.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
    expect(sortTradeRows(rows, { key: 'net', dir: 'asc' }).map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('flips the active column; a new text column starts ascending, a number descending', () => {
    expect(nextTradeSort(DEFAULT_TRADE_SORT, 'entry')).toEqual({ key: 'entry', dir: 'asc' });
    expect(nextTradeSort(DEFAULT_TRADE_SORT, 'personality')).toEqual({
      key: 'personality',
      dir: 'asc',
    });
    expect(nextTradeSort(DEFAULT_TRADE_SORT, 'net')).toEqual({ key: 'net', dir: 'desc' });
  });
});

describe('CSV export', () => {
  it('writes IST times without commas', () => {
    expect(csvIstDateTime('2026-09-28T04:00:00.000Z')).toBe('2026-09-28 09:30:00');
    expect(csvIstDateTime(null)).toBe('');
  });

  it('has a header for every value and plain values', () => {
    const [row] = tradeCsvRows(
      toTradeRows(
        [trade({ personality_id: 'p1', expiry: '2026-09-29T18:30:00.000Z' })],
        [personality()],
      ),
    );
    expect(Object.keys(row ?? {}).sort()).toEqual(TRADE_CSV_COLUMNS.map(([key]) => key).sort());
    expect(row).toMatchObject({
      personality: 'Clockwork',
      status: 'Closed',
      expiry: '2026-09-30',
      entry: '2026-09-28 09:30:00',
      exit: '2026-09-28 12:00:00',
      durationMin: 150,
      net: 650,
      pnlPct: 5,
      reason: 'Target hit',
      vix: '',
    });
  });

  it('names the file after the IST day', () => {
    expect(tradesCsvFilename('2026-10-05')).toBe('paper-trades-2026-10-05.csv');
  });
});
