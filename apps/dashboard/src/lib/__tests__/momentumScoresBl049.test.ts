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

// --- Phase 2: the rotation map's rows -------------------------------------------------------

import {
  type RotationGroup,
  TAIL_CHOICES,
  buildRotationRows,
  groupBySlug,
  meanScores,
  medianReturn,
  quadrantOf,
  rankInGroup,
  rotationEntry,
  shareAboveAverage,
  slugify,
  stocksInGroup,
  stocksInSub,
  strengthRank,
  subBySlug,
} from '../momentumScores';

/** A group whose 26-week score is `s26` and whose 4-week score runs `s4` over 18 weeks. */
function group(
  key: string,
  s4: Array<number | null>,
  s26: Array<number | null>,
  over: Partial<RotationGroup> = {},
): RotationGroup {
  const [parent = key, sub = null] = key.split(' :: ');
  return {
    key,
    parent_group: parent,
    subgroup: sub,
    theme: false,
    member_count: 10,
    scored_count: 10,
    s4,
    s26,
    ...over,
  };
}
const flat = (value: number): number[] => Array.from({ length: 18 }, () => value);
const ramp = (from: number, to: number): number[] =>
  Array.from({ length: 18 }, (_, i) => from + ((to - from) * i) / 17);

describe('quadrantOf', () => {
  it.each([
    [60, 5, 'leading'],
    [60, -5, 'weakening'],
    [40, 5, 'improving'],
    [40, -5, 'lagging'],
    [50, 0, 'leading'], // the lines belong to the stronger, rising side
    [49.9, 0, 'improving'],
  ])('(%s, %s) is %s', (x, y, quadrant) => expect(quadrantOf(x, y)).toBe(quadrant));
});

describe('rotationEntry', () => {
  it('places a group by its 26-week score and the change in its 4-week score over 4 weeks', () => {
    const g = group('Fin', ramp(40, 74), flat(70));
    const entry = rotationEntry(g, 4);
    // s4 rises 2 a week, so over 4 weeks it moved +8; the 26-week score is 70.
    expect(entry.now).toEqual({ x: 70, y: expect.closeTo(8) });
    expect(entry.quadrant).toBe('leading');
    expect(entry.tail).toHaveLength(5); // the last 4 weeks and now
    expect(entry.changed).toBe(false);
  });

  it('reports a move between quadrants over the last 4 weeks', () => {
    const s4 = [...flat(50).slice(0, 13), 50, 48, 46, 44, 42].slice(0, 18); // falling at the end
    const s26 = [...flat(60).slice(0, 13), 60, 59, 55, 51, 45].slice(0, 18); // crossing 50
    const entry = rotationEntry(group('Fin', s4, s26), 4);
    expect(entry.before).toBe('leading'); // 4 weeks ago: strong and not falling yet
    expect(entry.quadrant).toBe('lagging');
    expect(entry.changed).toBe(true);
  });

  it('has no position when a score it needs is missing, and skips gaps in the tail', () => {
    const missing = rotationEntry(group('Fin', flat(50), Array(18).fill(null)), 4);
    expect(missing.now).toBeNull();
    expect(missing.quadrant).toBeNull();
    expect(missing.changed).toBe(false);
    const gap = flat(50).map((v, i) => (i === 16 ? null : v));
    expect(rotationEntry(group('Fin', gap, flat(60)), 4).tail).toHaveLength(4);
  });

  it('draws a longer tail on request, but never before the 4-week change exists', () => {
    expect(TAIL_CHOICES).toEqual([4, 8, 13]);
    expect(rotationEntry(group('Fin', flat(50), flat(60)), 13).tail).toHaveLength(14);
    expect(rotationEntry(group('Fin', flat(50), flat(60)), 17).tail).toHaveLength(14);
  });
});

describe('rotation rows', () => {
  const opts = { tail: 4, minStocks: 5, query: '', changedOnly: false, lookbacks: [4, 13, 26] };
  const groups = [
    group('Strong', flat(50), flat(80)),
    group('Weak', flat(50), flat(20)),
    group('Tiny', flat(50), flat(90), { scored_count: 2 }),
    group('Cross-Sector Themes', flat(50), flat(95), { theme: true }),
    group('NoHistory', flat(50), Array(18).fill(null)),
  ];
  const stocksOf = () => [stock('A', { scores: { '4': 60, '13': 70, '26': 80 }, above_ma40: 0.1 })];

  it('puts dotted groups strongest first and the table-only ones after, each with a reason', () => {
    const rows = buildRotationRows(groups, stocksOf, opts);
    expect(rows.map((r) => r.entry.key)).toEqual([
      'Strong',
      'Weak',
      'Cross-Sector Themes',
      'Tiny',
      'NoHistory',
    ]);
    expect(rows.map((r) => r.onMap)).toEqual([true, true, false, false, false]);
    expect(rows.map((r) => r.why)).toEqual([
      null,
      null,
      'a theme basket, not a sector',
      'fewer than 5 scored stocks',
      'too little history',
    ]);
  });

  it('lets the minimum change who gets a dot', () => {
    const rows = buildRotationRows(groups, stocksOf, { ...opts, minStocks: 1 });
    expect(rows.find((r) => r.entry.key === 'Tiny')?.onMap).toBe(true);
    expect(rows.find((r) => r.entry.key === 'Cross-Sector Themes')?.onMap).toBe(false);
  });

  it('filters by name', () => {
    const rows = buildRotationRows(groups, stocksOf, { ...opts, query: ' STRONG' });
    expect(rows.map((r) => r.entry.key)).toEqual(['Strong']);
  });

  it('keeps only the groups that changed quadrant, and never a table-only one', () => {
    const moved = group(
      'Moved',
      flat(50).map((v, i) => (i >= 14 ? 40 : v)),
      flat(70),
    );
    const rows = buildRotationRows([...groups, moved], stocksOf, { ...opts, changedOnly: true });
    expect(rows.map((r) => r.entry.key)).toEqual(['Moved']);
  });

  it("carries each group's stocks, mean strip and breadth", () => {
    const row = buildRotationRows([groups[0] as RotationGroup], stocksOf, opts)[0];
    expect(row?.strip).toEqual({ '4': 60, '13': 70, '26': 80 });
    expect(row?.above).toBe(1);
  });
});

describe('slugs and lookups', () => {
  const groups = [
    group('Metals & Mining', flat(50), flat(60)),
    group('Financials', flat(50), flat(70)),
  ];
  const subs = [
    group('Financials :: PSU Banks', flat(50), flat(70)),
    group('Metals & Mining :: PSU Banks', flat(50), flat(70)),
  ];
  it('slugifies names for URLs', () => {
    expect(slugify('Metals & Mining')).toBe('metals-and-mining');
    expect(slugify('Oil, Gas & Consumable Fuels')).toBe('oil-gas-and-consumable-fuels');
    expect(slugify('  PSU / CPSE Stocks ')).toBe('psu-cpse-stocks');
  });
  it('finds a group and a sub-sector by slug, and none for a stranger', () => {
    expect(groupBySlug(groups, 'metals-and-mining')?.key).toBe('Metals & Mining');
    expect(groupBySlug(groups, 'nope')).toBeNull();
    expect(groupBySlug(groups, null)).toBeNull();
    expect(subBySlug(subs, 'Financials', 'psu-banks')?.key).toBe('Financials :: PSU Banks');
    expect(subBySlug(subs, 'Metals & Mining', 'psu-banks')?.key).toBe(
      'Metals & Mining :: PSU Banks',
    );
    expect(subBySlug(subs, 'Financials', 'insurance')).toBeNull();
  });
  it('ranks a group by strength among the sector groups, leaving out themes', () => {
    const all = [...groups, group('Cross-Sector Themes', flat(50), flat(99), { theme: true })];
    expect(strengthRank(all[1] as RotationGroup, all)).toEqual({ place: 1, of: 2 });
    expect(strengthRank(all[0] as RotationGroup, all)).toEqual({ place: 2, of: 2 });
    expect(strengthRank(group('X', flat(50), Array(18).fill(null)), all)).toBeNull();
  });
});

describe('a group of stocks', () => {
  const stocks = [
    stock('A', {
      tags: [
        { parent_group: 'Cross-Sector Themes', subgroup: 'PSU' },
        { parent_group: 'Financials', subgroup: 'PSU Banks' },
      ],
      scores: { '26': 80 },
      returns: { '26': 0.3 },
      above_ma40: 0.1,
      composite_rank: 5,
    }),
    stock('B', {
      parent_group: 'Financials',
      subgroup: 'Insurance',
      scores: { '26': 40 },
      returns: { '26': 0.1 },
      above_ma40: -0.1,
      composite_rank: 9,
    }),
    stock('C', {
      parent_group: 'Health',
      subgroup: 'Pharma',
      scores: { '26': null },
      composite_rank: 2,
    }),
  ];
  it('lists them by parent group and sub-sector, each stock once', () => {
    expect(stocksInGroup(stocks, 'Financials').map((s) => s.symbol)).toEqual(['A', 'B']);
    expect(stocksInGroup(stocks, 'Cross-Sector Themes').map((s) => s.symbol)).toEqual(['A']);
    expect(stocksInSub(stocks, 'Financials', 'PSU Banks').map((s) => s.symbol)).toEqual(['A']);
    expect(stocksInSub(stocks, 'Financials', 'Pharma')).toEqual([]);
  });
  it('summarises them', () => {
    const fin = stocksInGroup(stocks, 'Financials');
    expect(meanScores(fin, [26])).toEqual({ '26': 60 });
    expect(meanScores([stocks[2] as StockScore], [26])).toEqual({ '26': null });
    expect(shareAboveAverage(fin)).toBe(0.5);
    expect(shareAboveAverage([stocks[2] as StockScore])).toBeNull();
    expect(medianReturn(fin)).toBeCloseTo(0.2);
    expect(medianReturn(stocks)).toBeCloseTo(0.2);
    expect(medianReturn([])).toBeNull();
  });
  it("places a stock among its sector's by composite rank", () => {
    const fin = stocksInGroup(stocks, 'Financials');
    expect(rankInGroup(fin[0] as StockScore, fin)).toEqual({ place: 1, of: 2 });
    expect(rankInGroup(fin[1] as StockScore, fin)).toEqual({ place: 2, of: 2 });
    expect(rankInGroup(stock('Z'), fin)).toBeNull();
  });
});
