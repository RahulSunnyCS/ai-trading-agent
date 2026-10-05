import { describe, expect, it } from 'vitest';

import type { PaperTrade, RegimeTag } from '../../types/trading';
import {
  addDays,
  dayRegimes,
  istDay,
  pnlByRegime,
  presentRegimes,
  regimeDistribution,
  stripCells,
  underlyingOptions,
  weekdayOf,
  windowRange,
} from '../regimeTags';

function tag(trade_date: string, regime: string, confidence: string | null = '0.8000'): RegimeTag {
  return {
    trade_date,
    symbol: 'NIFTY',
    regime,
    regime_confidence: confidence,
    classified_at: '2026-10-01T10:00:00.000Z',
  };
}

function trade(over: Partial<PaperTrade>): PaperTrade {
  return {
    id: Math.random().toString(36),
    entry_time: '2026-10-01T04:00:00.000Z',
    exit_time: '2026-10-01T09:00:00.000Z',
    status: 'closed',
    straddle_at_entry: null,
    entry_ce_price: null,
    entry_pe_price: null,
    gross_pnl: null,
    net_pnl: '100',
    exit_reason: 'TARGET',
    lots: 1,
    lot_size: 65,
    symbol: 'NIFTY',
    ...over,
  };
}

describe('istDay', () => {
  it('reads a plain day as itself', () => {
    expect(istDay('2026-10-05')).toBe('2026-10-05');
  });

  it('reads a DATE serialised by a UTC server (midnight UTC) as that day', () => {
    expect(istDay('2026-10-05T00:00:00.000Z')).toBe('2026-10-05');
  });

  it('reads a DATE serialised by an IST server (18:30 UTC the day before) as the IST day', () => {
    expect(istDay('2026-10-04T18:30:00.000Z')).toBe('2026-10-05');
  });

  it('puts an exit just after IST midnight on the new day', () => {
    expect(istDay('2026-10-04T18:45:00.000Z')).toBe('2026-10-05');
    expect(istDay('2026-10-04T18:15:00.000Z')).toBe('2026-10-04');
  });

  it('returns null for missing or garbage input', () => {
    expect(istDay(null)).toBeNull();
    expect(istDay('not a date')).toBeNull();
  });
});

describe('day arithmetic', () => {
  it('adds days across a month end', () => {
    expect(addDays('2026-09-29', 3)).toBe('2026-10-02');
    expect(addDays('2026-10-02', -3)).toBe('2026-09-29');
  });

  it('names weekdays', () => {
    expect(weekdayOf('2026-10-05')).toBe('Mon');
    expect(weekdayOf('2026-10-04')).toBe('Sun');
  });

  it('builds the window ending today in IST', () => {
    // 20:00 UTC on 4 Oct is 01:30 IST on 5 Oct.
    expect(windowRange(30, new Date('2026-10-04T20:00:00Z'))).toEqual({
      from: '2026-09-05',
      to: '2026-10-05',
    });
  });
});

describe('dayRegimes', () => {
  it('normalises keys and sorts oldest first, one entry per day', () => {
    const days = dayRegimes([
      tag('2026-10-02T00:00:00.000Z', 'ranging'),
      tag('2026-10-01T00:00:00.000Z', 'EVENT_DAY', null),
      tag('2026-10-02T00:00:00.000Z', 'TRENDING_STRONG'),
    ]);
    expect(days.map((d) => [d.day, d.regime, d.confidence])).toEqual([
      ['2026-10-01', 'EVENT_DAY', null],
      ['2026-10-02', 'TRENDING_STRONG', 0.8],
    ]);
  });
});

describe('stripCells', () => {
  it('fills untagged weekdays between the first and last tag and skips weekends', () => {
    // Thu 1 Oct … Tue 6 Oct; Fri 2 Oct has no tag; Sat/Sun are skipped.
    const cells = stripCells(
      dayRegimes([
        tag('2026-10-01', 'RANGING'),
        tag('2026-10-05', 'RANGING'),
        tag('2026-10-06', 'EVENT_DAY'),
      ]),
    );
    expect(cells.map((c) => [c.day, c.weekday, c.tag?.regime ?? null])).toEqual([
      ['2026-10-01', 'Thu', 'RANGING'],
      ['2026-10-02', 'Fri', null],
      ['2026-10-05', 'Mon', 'RANGING'],
      ['2026-10-06', 'Tue', 'EVENT_DAY'],
    ]);
  });

  it('is empty without tags', () => {
    expect(stripCells([])).toEqual([]);
  });
});

describe('regimeDistribution', () => {
  it('lists every tagger regime (zero when absent) and shares of tagged days', () => {
    const { total, rows } = regimeDistribution(
      dayRegimes([
        tag('2026-10-01', 'RANGING'),
        tag('2026-10-02', 'RANGING'),
        tag('2026-10-05', 'UNCLASSIFIED'),
        tag('2026-10-06', 'EVENT_DAY'),
      ]),
    );
    expect(total).toBe(4);
    expect(rows.map((r) => [r.regime, r.days, r.share])).toEqual([
      ['EVENT_DAY', 1, 0.25],
      ['VOLATILE_REVERTING', 0, 0],
      ['TRENDING_STRONG', 0, 0],
      ['RANGING', 2, 0.5],
      ['UNCLASSIFIED', 1, 0.25],
    ]);
  });

  it('has zero shares, not NaN, when there are no days', () => {
    expect(regimeDistribution([]).rows.every((r) => r.share === 0)).toBe(true);
  });
});

describe('presentRegimes', () => {
  it('lists the regimes in the data in tagger order', () => {
    const days = dayRegimes([tag('2026-10-01', 'RANGING'), tag('2026-10-02', 'EVENT_DAY')]);
    expect(presentRegimes(days)).toEqual(['EVENT_DAY', 'RANGING']);
  });
});

describe('underlyingOptions', () => {
  it('combines the current underlying, tag symbols and trade symbols', () => {
    expect(
      underlyingOptions(
        'NIFTY',
        [tag('2026-10-01', 'RANGING')],
        [trade({ symbol: 'banknifty' }), trade({ symbol: null })],
      ),
    ).toEqual(['BANKNIFTY', 'NIFTY']);
  });
});

describe('pnlByRegime', () => {
  const days = dayRegimes([tag('2026-10-01', 'RANGING'), tag('2026-10-02', 'TRENDING_STRONG')]);
  const window = { underlying: 'NIFTY', from: '2026-09-01', to: '2026-10-05' };

  it('groups closed trades by the regime of their IST exit day', () => {
    const result = pnlByRegime(
      [
        trade({ exit_time: '2026-10-01T09:00:00.000Z', net_pnl: '150.50' }),
        trade({ exit_time: '2026-10-01T09:30:00.000Z', net_pnl: '-50.50' }),
        // 19:00 UTC on 1 Oct is 00:30 IST on 2 Oct.
        trade({ exit_time: '2026-10-01T19:00:00.000Z', net_pnl: '200' }),
      ],
      days,
      window,
    );
    expect(result.rows).toEqual([
      { regime: 'TRENDING_STRONG', trades: 1, wins: 1, netPnl: 200 },
      { regime: 'RANGING', trades: 2, wins: 1, netPnl: 100 },
    ]);
    expect(result.joined).toBe(3);
  });

  it('puts trades on untagged days in their own row, last', () => {
    const result = pnlByRegime(
      [trade({ exit_time: '2026-10-05T09:00:00.000Z' }), trade({})],
      days,
      window,
    );
    expect(result.rows.map((r) => r.regime)).toEqual(['RANGING', '']);
    expect(result.untagged).toBe(1);
  });

  it('leaves out open trades, other underlyings and exits outside the window', () => {
    const result = pnlByRegime(
      [
        trade({ status: 'open', exit_time: null }),
        trade({ symbol: 'BANKNIFTY' }),
        trade({ exit_time: '2026-08-01T09:00:00.000Z' }),
      ],
      days,
      window,
    );
    expect(result.rows).toEqual([]);
    expect(result.joined).toBe(0);
  });

  it('counts a trade without a usable net P&L instead of summing it as zero', () => {
    const result = pnlByRegime([trade({ net_pnl: null }), trade({ net_pnl: 'abc' })], days, window);
    expect(result.rows).toEqual([]);
    expect(result.missingPnl).toBe(2);
  });

  it('treats a trade without a symbol as NIFTY', () => {
    expect(pnlByRegime([trade({ symbol: null })], days, window).joined).toBe(1);
    expect(
      pnlByRegime([trade({ symbol: null })], days, { ...window, underlying: 'SENSEX' }).joined,
    ).toBe(0);
  });
});
