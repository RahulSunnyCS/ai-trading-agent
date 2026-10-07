import { describe, expect, it } from 'vitest';

import {
  DECILE_CLASS,
  DEFAULT_BUY_ZONE,
  type ScoreSort,
  type SectorScore,
  type StockScore,
  activeSignalFromJob,
  ariaSort,
  buyZoneFrom,
  computeMovers,
  decileOf,
  filterStocks,
  inView,
  leaderCount,
  markKey,
  nextSort,
  rankChange,
  sectorMembers,
  sortStocks,
  stockDecile,
  topSector,
  trendOf,
  viewCounts,
} from '../momentumScores';

function stock(symbol: string, over: Partial<StockScore> = {}): StockScore {
  return {
    symbol,
    company_name: `${symbol} Ltd.`,
    parent_group: 'Financials',
    subgroup: 'Banks',
    last_price: 100,
    change_1w_pct: 0,
    returns: {},
    scores: {},
    ...over,
  };
}

/** A stock whose 4, 13 and 26-week percentile scores give those deciles. */
function shaped(
  symbol: string,
  d4: number,
  d13: number,
  d26: number,
  over: Partial<StockScore> = {},
) {
  const score = (decile: number): number => (decile - 1) * 10 + 5;
  return stock(symbol, { scores: { '4': score(d4), '13': score(d13), '26': score(d26) }, ...over });
}

describe('decileOf', () => {
  it.each([
    [0, 1],
    [9.9, 1],
    [10, 2],
    [50, 6],
    [89.9, 9],
    [90, 10],
    [100, 10],
  ])('score %s -> decile %s', (score, decile) => expect(decileOf(score)).toBe(decile));

  it('is null without a usable score', () => {
    expect(decileOf(null)).toBeNull();
    expect(decileOf(undefined)).toBeNull();
    expect(decileOf(Number.NaN)).toBeNull();
  });

  it('has a colour for every decile', () => {
    for (let decile = 1; decile <= 10; decile += 1) expect(DECILE_CLASS[decile]).toBeTruthy();
  });

  it('reads a stock at one lookback', () => {
    expect(stockDecile(shaped('A', 3, 7, 10), 26)).toBe(10);
    expect(stockDecile(shaped('A', 3, 7, 10), 8)).toBeNull();
  });
});

describe('trendOf', () => {
  it.each([
    ['leader', shaped('A', 9, 9, 10)],
    ['leader', shaped('A', 7, 8, 8)], // the weakest leader
    ['mixed', shaped('A', 6, 8, 8)], // 4-week decile one short of a leader
    ['emerging', shaped('A', 10, 7, 4)],
    ['fading', shaped('A', 3, 8, 9)],
    ['laggard', shaped('A', 2, 3, 3)],
    ['mixed', shaped('A', 5, 5, 5)],
  ])('is %s', (tag, s) => expect(trendOf(s)).toBe(tag));

  it('is null when one of the three scores is missing', () => {
    expect(trendOf(stock('A', { scores: { '4': 90, '13': 90 } }))).toBeNull();
  });
});

describe('the buy zone', () => {
  it("uses the active favourite's Broad numbers", () => {
    expect(buyZoneFrom({ config: { broad_off_top_n: 8, broad_off_exit_rank: 15 } })).toEqual({
      topN: 8,
      exitRank: 15,
      source: 'favourite',
    });
  });
  it("falls back to Broad's defaults for no favourite, an ETF favourite or nonsense", () => {
    expect(buyZoneFrom(undefined)).toBe(DEFAULT_BUY_ZONE);
    expect(buyZoneFrom({ config: { top_n: 5, exit_rank: 10 } })).toBe(DEFAULT_BUY_ZONE);
    expect(buyZoneFrom({ config: { broad_off_top_n: 20, broad_off_exit_rank: 10 } })).toBe(
      DEFAULT_BUY_ZONE,
    );
    expect(buyZoneFrom({ config: { broad_off_top_n: 0, broad_off_exit_rank: 10 } })).toBe(
      DEFAULT_BUY_ZONE,
    );
  });
});

describe('rank movement and the movers', () => {
  const ranked = (symbol: string, now: number | null, before: number | null) =>
    stock(symbol, { composite_rank: now, composite_rank_prev: before });
  const stocks = [
    ranked('UP25', 48, 73),
    ranked('UP2', 3, 5),
    ranked('DOWN', 30, 10),
    ranked('IN', 18, 40),
    ranked('STAY', 5, 5),
    ranked('NEW', 4, null),
    ranked('GONE', null, 12),
    ranked('OUT2', 25, 20),
    ranked('NOISE', 300, 600), // a huge jump, but nowhere near the top
  ];

  it('counts places gained as positive', () => {
    expect(rankChange(stocks[0] as StockScore)).toBe(25);
    expect(rankChange(stocks[2] as StockScore)).toBe(-20);
    expect(rankChange(stocks[5] as StockScore)).toBeNull();
  });

  it('lists the climbers, those who entered the zone and those who left it', () => {
    const movers = computeMovers(stocks, { topN: 10, exitRank: 20, source: 'default' });
    expect(movers.climbers.map((s) => s.symbol)).toEqual(['UP25', 'IN', 'UP2']); // not NOISE
    expect(movers.entered.map((s) => s.symbol)).toEqual(['IN']);
    expect(movers.dropped.map((s) => s.symbol)).toEqual(['DOWN', 'OUT2']);
  });

  it('limits each list', () => {
    const many = Array.from({ length: 12 }, (_, i) => ranked(`S${i}`, i + 1, i + 30));
    expect(computeMovers(many, DEFAULT_BUY_ZONE, 3).climbers).toHaveLength(3);
  });
});

describe('quick views', () => {
  const marks = new Map([
    ['HELD', 'held' as const],
    ['CAND', 'candidate' as const],
  ]);
  const stocks = [
    shaped('LEAD', 9, 9, 9, { high_52w_gap: -0.02 }),
    shaped('EMER', 9, 6, 4, { high_52w_gap: -0.3 }),
    shaped('HELD', 5, 5, 5),
    shaped('CAND', 2, 2, 2, { high_52w_gap: -0.05 }),
  ];

  it('filters each view', () => {
    expect(stocks.filter((s) => inView(s, 'leaders', marks)).map((s) => s.symbol)).toEqual([
      'LEAD',
    ]);
    expect(stocks.filter((s) => inView(s, 'emerging', marks)).map((s) => s.symbol)).toEqual([
      'EMER',
    ]);
    expect(stocks.filter((s) => inView(s, 'near_high', marks)).map((s) => s.symbol)).toEqual([
      'LEAD',
      'CAND',
    ]);
    expect(stocks.filter((s) => inView(s, 'held', marks)).map((s) => s.symbol)).toEqual(['HELD']);
    expect(stocks.filter((s) => inView(s, 'candidates', marks)).map((s) => s.symbol)).toEqual([
      'CAND',
    ]);
    expect(stocks.every((s) => inView(s, 'all', undefined))).toBe(true);
  });

  it('counts them for the chips, and counts leaders', () => {
    const counts = viewCounts(stocks, marks);
    expect(counts).toMatchObject({ all: 4, leaders: 1, emerging: 1, held: 1, candidates: 1 });
    expect(leaderCount(stocks)).toBe(1);
  });
});

describe('the strongest sub-sector', () => {
  const sector = (subgroup: string, score: number | null, n: number): SectorScore => ({
    cid: subgroup,
    parent_group: 'P',
    subgroup,
    member_count: n,
    qualifying_count: n,
    scores: { '26': score },
  });
  it('is the best 26-week score among sectors with enough stocks', () => {
    expect(
      topSector([sector('Tiny', 99, 2), sector('Big', 80, 9), sector('Mid', 70, 6)])?.subgroup,
    ).toBe('Big');
  });
  it('is null when none qualifies', () => {
    expect(topSector([sector('Tiny', 99, 2), sector('Blank', null, 9)])).toBeNull();
  });
});

describe('sorting by rank, 52-week high and return', () => {
  const stocks = [
    stock('B', { composite_rank: 2, high_52w_gap: -0.2, returns: { '13': 0.1 } }),
    stock('A', { composite_rank: 1, high_52w_gap: 0, returns: { '13': 0.3 } }),
    stock('N', { composite_rank: null, high_52w_gap: null, returns: { '13': null } }),
    stock('C', { composite_rank: 3, high_52w_gap: -0.05, returns: { '13': 0.2 } }),
  ];
  const order = (sort: ScoreSort) =>
    sortStocks(stocks, sort)
      .map((s) => s.symbol)
      .join('');

  it('puts rank 1 first, and the unranked last either way', () => {
    expect(order({ key: 'rank', lookback: null, ascending: true })).toBe('ABCN');
    expect(order({ key: 'rank', lookback: null, ascending: false })).toBe('CBAN');
  });
  it('sorts by distance from the 52-week high, closest first', () => {
    expect(order({ key: 'high', lookback: null, ascending: false })).toBe('ACBN');
  });
  it('sorts by one lookback return', () => {
    expect(order({ key: 'return', lookback: 13, ascending: false })).toBe('ACBN');
  });
  it('starts the rank column at 1 and the other numbers at the top, and tells the two returns apart', () => {
    const start: ScoreSort = { key: 'name', lookback: null, ascending: true };
    expect(nextSort(start, 'rank')).toEqual({ key: 'rank', lookback: null, ascending: true });
    expect(nextSort(start, 'high')).toEqual({ key: 'high', lookback: null, ascending: false });
    const by13 = nextSort(start, 'return', 13);
    expect(ariaSort(by13, 'return', 13)).toBe('descending');
    expect(ariaSort(by13, 'return', 26)).toBe('none');
  });
});

describe('tags', () => {
  const sbin = stock('SBIN', {
    parent_group: 'Financials',
    subgroup: 'PSU Banks',
    tags: [
      { parent_group: 'Cross-Sector Themes', subgroup: 'PSU / CPSE Stocks' },
      { parent_group: 'Financials', subgroup: 'PSU Banks' },
    ],
  });
  it('lists a stock under every group it is tagged to', () => {
    expect(
      sectorMembers([sbin], { parent_group: 'Cross-Sector Themes', subgroup: 'PSU / CPSE Stocks' }),
    ).toHaveLength(1);
    expect(
      sectorMembers([sbin], { parent_group: 'Financials', subgroup: 'PSU Banks' }),
    ).toHaveLength(1);
    expect(
      sectorMembers([sbin], { parent_group: 'Financials', subgroup: 'Insurance' }),
    ).toHaveLength(0);
  });
  it('searches by any tag', () => {
    expect(filterStocks([sbin], { query: 'cpse', group: '' })).toHaveLength(1);
  });
});

describe('Held / Candidate from a weekly signal (BL-049 fixes)', () => {
  it('ignores a split segment suffix', () => {
    expect(markKey('tatamotors#2')).toBe('TATAMOTORS');
    expect(markKey(' Nifty 50 ')).toBe('NIFTY 50');
  });

  const job = (dataset: string, config: Record<string, unknown>) => ({
    job: {
      status: 'done',
      result: {
        strategies: [
          {
            active: true,
            name: 'S',
            dataset,
            signal: {
              week: '2026-10-02',
              config,
              rows: [
                { asset: 'AAA', rank: 8, action: 'HOLD', held: false },
                { asset: 'BBB', rank: 3, action: 'HOLD', held: false },
              ],
            },
          },
        ],
      },
    },
  });

  it("uses Broad's own N, not the unused top_n of the request", () => {
    const marks = activeSignalFromJob(job('broad', { top_n: 5, broad_off_top_n: 10 }))?.marks;
    expect(marks?.get('AAA')).toBe('candidate'); // rank 8 is inside 10
    expect(marks?.get('BBB')).toBe('candidate');
  });
  it('still uses top_n for the ETF strategy', () => {
    const marks = activeSignalFromJob(job('etf', { top_n: 5 }))?.marks;
    expect(marks?.get('AAA')).toBeUndefined();
    expect(marks?.get('BBB')).toBe('candidate');
  });
});
