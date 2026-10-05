import { describe, expect, it } from 'vitest';

import {
  ALL_GROUPS,
  type ScoreSort,
  type SectorScore,
  type StockScore,
  activeSignalFromJob,
  ariaSort,
  filterSectors,
  filterStocks,
  nextSort,
  parentGroups,
  scoreBand,
  sectorMembers,
  signOf,
  signalMarks,
  sortSectors,
  sortStocks,
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

function sector(subgroup: string, over: Partial<SectorScore> = {}): SectorScore {
  return {
    cid: subgroup,
    parent_group: 'Financials',
    subgroup,
    member_count: 2,
    qualifying_count: 2,
    scores: {},
    ...over,
  };
}

const STOCKS = [
  stock('AAA', { last_price: 50, change_1w_pct: 0.02, scores: { '4': 10, '26': 90 } }),
  stock('BBB', {
    parent_group: 'Healthcare',
    subgroup: 'Pharma',
    last_price: null,
    change_1w_pct: -0.05,
    scores: { '4': 80, '26': null },
  }),
  stock('CCC', {
    company_name: 'Charlie Metals',
    parent_group: 'Metals & Mining',
    subgroup: 'Steel',
    last_price: 900,
    change_1w_pct: null,
    scores: { '4': 45, '26': 30 },
  }),
];

const symbols = (rows: StockScore[]) => rows.map((row) => row.symbol);

describe('sorting', () => {
  const byScore = (lookback: number, ascending = false): ScoreSort => ({
    key: 'score',
    lookback,
    ascending,
  });

  it('ranks by the chosen lookback score, highest first', () => {
    expect(symbols(sortStocks(STOCKS, byScore(4)))).toEqual(['BBB', 'CCC', 'AAA']);
    expect(symbols(sortStocks(STOCKS, byScore(26)))).toEqual(['AAA', 'CCC', 'BBB']);
  });

  it('keeps missing values last in both directions', () => {
    expect(symbols(sortStocks(STOCKS, byScore(26, true)))).toEqual(['CCC', 'AAA', 'BBB']);
    const byPrice = { key: 'price', lookback: null } as const;
    expect(symbols(sortStocks(STOCKS, { ...byPrice, ascending: true }))).toEqual([
      'AAA',
      'CCC',
      'BBB',
    ]);
    expect(symbols(sortStocks(STOCKS, { ...byPrice, ascending: false }))).toEqual([
      'CCC',
      'AAA',
      'BBB',
    ]);
    expect(
      symbols(sortStocks(STOCKS, { key: 'change', lookback: null, ascending: false })),
    ).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('sorts by symbol and does not mutate the input', () => {
    const input = [...STOCKS].reverse();
    const sorted = sortStocks(input, { key: 'name', lookback: null, ascending: true });
    expect(symbols(sorted)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(symbols(input)).toEqual(['CCC', 'BBB', 'AAA']);
  });

  it('sorts sectors by name, qualifying members and score', () => {
    const sectors = [
      sector('Banks', { qualifying_count: 3, scores: { '4': 20 } }),
      sector('Steel', { qualifying_count: 9, scores: { '4': 70 } }),
      sector('Pharma', { qualifying_count: 1, scores: { '4': null } }),
    ];
    const names = (rows: SectorScore[]) => rows.map((row) => row.subgroup);
    expect(names(sortSectors(sectors, { key: 'name', lookback: null, ascending: true }))).toEqual([
      'Banks',
      'Pharma',
      'Steel',
    ]);
    expect(
      names(sortSectors(sectors, { key: 'members', lookback: null, ascending: false })),
    ).toEqual(['Steel', 'Banks', 'Pharma']);
    expect(names(sortSectors(sectors, byScore(4)))).toEqual(['Steel', 'Banks', 'Pharma']);
  });
});

describe('sort header state', () => {
  const start: ScoreSort = { key: 'score', lookback: 26, ascending: false };

  it('flips direction on the active column', () => {
    expect(nextSort(start, 'score', 26)).toEqual({ key: 'score', lookback: 26, ascending: true });
  });

  it('starts another lookback highest first', () => {
    const flipped = nextSort(start, 'score', 26);
    expect(nextSort(flipped, 'score', 4)).toEqual({ key: 'score', lookback: 4, ascending: false });
  });

  it('starts names A to Z and numbers highest first', () => {
    expect(nextSort(start, 'name')).toEqual({ key: 'name', lookback: null, ascending: true });
    expect(nextSort(start, 'price')).toEqual({ key: 'price', lookback: null, ascending: false });
  });

  it('reports aria-sort only for the active column', () => {
    expect(ariaSort(start, 'score', 26)).toBe('descending');
    expect(ariaSort(start, 'score', 4)).toBe('none');
    expect(ariaSort(start, 'name')).toBe('none');
    expect(ariaSort(nextSort(start, 'name'), 'name')).toBe('ascending');
  });
});

describe('filtering', () => {
  it('lists parent groups with counts, A to Z', () => {
    expect(parentGroups([...STOCKS, stock('DDD')])).toEqual([
      { group: 'Financials', count: 2 },
      { group: 'Healthcare', count: 1 },
      { group: 'Metals & Mining', count: 1 },
    ]);
  });

  it('matches text against symbol, company and sector, ignoring case', () => {
    expect(symbols(filterStocks(STOCKS, { query: ' charlie ', group: ALL_GROUPS }))).toEqual([
      'CCC',
    ]);
    expect(symbols(filterStocks(STOCKS, { query: 'pharma', group: ALL_GROUPS }))).toEqual(['BBB']);
    expect(symbols(filterStocks(STOCKS, { query: '', group: ALL_GROUPS }))).toEqual([
      'AAA',
      'BBB',
      'CCC',
    ]);
  });

  it('combines the parent group with the text filter', () => {
    expect(symbols(filterStocks(STOCKS, { query: '', group: 'Healthcare' }))).toEqual(['BBB']);
    expect(filterStocks(STOCKS, { query: 'aaa', group: 'Healthcare' })).toEqual([]);
    expect(symbols(filterStocks(STOCKS, { query: 'aaa', group: 'Financials' }))).toEqual(['AAA']);
  });

  it('filters sectors by group and text', () => {
    const sectors = [sector('Banks'), sector('Pharma', { parent_group: 'Healthcare' })];
    expect(filterSectors(sectors, { query: '', group: 'Healthcare' }).map((s) => s.cid)).toEqual([
      'Pharma',
    ]);
    expect(
      filterSectors(sectors, { query: 'financ', group: ALL_GROUPS }).map((s) => s.cid),
    ).toEqual(['Banks']);
  });

  it('finds the stocks tagged to a sector', () => {
    expect(
      symbols(sectorMembers(STOCKS, { parent_group: 'Financials', subgroup: 'Banks' })),
    ).toEqual(['AAA']);
  });
});

describe('score bands and signs', () => {
  it('bands a 0–100 score', () => {
    expect(scoreBand(0)).toBe('weak');
    expect(scoreBand(40)).toBe('weak');
    expect(scoreBand(40.1)).toBe('middle');
    expect(scoreBand(60)).toBe('middle');
    expect(scoreBand(60.1)).toBe('strong');
    expect(scoreBand(null)).toBeNull();
    expect(scoreBand(undefined)).toBeNull();
    expect(scoreBand(Number.NaN)).toBeNull();
  });

  it('gives the sign of a return', () => {
    expect(signOf(0.01)).toBe(1);
    expect(signOf(-0.01)).toBe(-1);
    expect(signOf(0)).toBe(0);
    expect(signOf(null)).toBeNull();
  });
});

describe('signal marks', () => {
  const rows = [
    { asset: 'AAA', rank: 1, action: 'HOLD', held: true },
    { asset: 'bbb', rank: 2, action: 'BUY', held: false },
    { asset: 'CCC', rank: 30, action: 'SELL', held: true },
    { asset: 'DDD', rank: 3, action: 'WAIT', held: false },
    { asset: 'EEE', rank: 4, action: '', held: false },
    { asset: 'FFF', rank: 40, action: '', held: false },
    { asset: 'Nifty IT', etf: 'ITBEES', rank: 5, action: 'BUY (make room)', held: false },
    { rank: 1, held: true },
    'junk',
  ];

  it('marks held rows and buy-zone rows', () => {
    const marks = signalMarks(rows, 5);
    expect(marks.get('AAA')).toBe('held');
    expect(marks.get('BBB')).toBe('candidate');
    expect(marks.get('CCC')).toBe('held');
    expect(marks.get('DDD')).toBe('candidate');
    expect(marks.get('EEE')).toBe('candidate');
    expect(marks.has('FFF')).toBe(false);
    expect(marks.get('NIFTY IT')).toBe('candidate');
    expect(marks.get('ITBEES')).toBe('candidate');
    expect(marks.size).toBe(7);
  });

  it('needs an action when the strategy has no top N', () => {
    const marks = signalMarks(rows);
    expect(marks.get('BBB')).toBe('candidate');
    expect(marks.has('EEE')).toBe(false);
  });

  it('returns nothing for a missing or malformed payload', () => {
    expect(signalMarks(undefined).size).toBe(0);
    expect(signalMarks({ rows: [] }).size).toBe(0);
  });

  it('reads the active strategy out of a finished weekly job', () => {
    const job = {
      job: {
        status: 'done',
        result: {
          strategies: [
            { name: 'Other', dataset: 'etf', active: false, blocked: null, signal: { rows } },
            {
              name: 'Stock Core',
              dataset: 'stock',
              active: true,
              blocked: null,
              signal: { week: '2026-10-02', rows, config: { top_n: 5 } },
            },
          ],
        },
      },
    };
    const active = activeSignalFromJob(job);
    expect(active?.name).toBe('Stock Core');
    expect(active?.dataset).toBe('stock');
    expect(active?.week).toBe('2026-10-02');
    expect(active?.marks.get('EEE')).toBe('candidate');
  });

  it('keeps a blocked active strategy, with no marks', () => {
    const active = activeSignalFromJob({
      job: {
        status: 'done',
        result: {
          strategies: [
            { name: 'Broad', dataset: 'broad', active: true, blocked: 'No data', signal: null },
          ],
        },
      },
    });
    expect(active?.blocked).toBe('No data');
    expect(active?.marks.size).toBe(0);
  });

  it('is null without a finished job or an active strategy', () => {
    expect(activeSignalFromJob(null)).toBeNull();
    expect(activeSignalFromJob({ job: null })).toBeNull();
    expect(activeSignalFromJob({ job: { status: 'running', result: null } })).toBeNull();
    expect(
      activeSignalFromJob({
        job: { status: 'done', result: { strategies: [{ name: 'X', active: false }] } },
      }),
    ).toBeNull();
  });
});
