import { describe, expect, it } from 'vitest';

import {
  buildRebalanceTable,
  parseHoldingsPaste,
  previewBlocker,
  targetAsHoldings,
  toDrafts,
  validateHoldings,
} from '../momentumRebalance';

describe('validateHoldings', () => {
  it('ignores blank rows and returns the request map', () => {
    expect(
      validateHoldings([
        { asset: ' RELIANCE ', percent: '40' },
        { asset: '', percent: '' },
        { asset: 'TCS', percent: '12.5' },
      ]),
    ).toEqual({ holdings: { RELIANCE: 40, TCS: 12.5 }, allocated: 52.5, error: null });
  });

  it.each([
    [[{ asset: '', percent: '10' }], /Holding 1: choose an asset/],
    [[{ asset: 'TCS', percent: '' }], /Holding 1 \(TCS\)/],
    [[{ asset: 'TCS', percent: '101' }], /0 to 100/],
    [[{ asset: 'TCS', percent: '-1' }], /0 to 100/],
    [
      [
        { asset: 'TCS', percent: '10' },
        { asset: 'TCS', percent: '5' },
      ],
      /Duplicate holding: TCS/,
    ],
    [
      [
        { asset: 'TCS', percent: '60' },
        { asset: 'INFY', percent: '50' },
      ],
      /more than 100%/,
    ],
  ])('rejects %j', (rows, message) => {
    const result = validateHoldings(rows);
    expect(result.error).toMatch(message);
    expect(result.holdings).toEqual({});
  });
});

describe('previewBlocker', () => {
  const ok = {
    loading: false,
    hasConfig: true,
    holdingsError: null,
    portfolioValue: '100000',
    strategyStartDate: '2026-09-18',
  };

  it('is null when everything is filled in', () => {
    expect(previewBlocker(ok)).toBeNull();
  });

  it('gives the first reason that applies', () => {
    expect(previewBlocker({ ...ok, loading: true })).toMatch(/still loading/);
    expect(previewBlocker({ ...ok, hasConfig: false })).toMatch(/could not be loaded/);
    expect(previewBlocker({ ...ok, holdingsError: 'Duplicate holding: TCS.' })).toBe(
      'Duplicate holding: TCS.',
    );
    expect(previewBlocker({ ...ok, portfolioValue: '0' })).toMatch(/positive total portfolio/);
    expect(previewBlocker({ ...ok, portfolioValue: ' ' })).toMatch(/positive total portfolio/);
    expect(previewBlocker({ ...ok, strategyStartDate: '' })).toMatch(/date you started/);
  });
});

describe('parseHoldingsPaste', () => {
  it('reads space, comma, tab, semicolon and colon separators, with or without %', () => {
    const result = parseHoldingsPaste(
      ['RELIANCE 12.5', 'TCS,10', 'INFY\t7.5%', 'HDFCBANK; 5 %', 'Gold: 3', 'ITC = .5'].join('\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.holdings).toEqual([
      { asset: 'RELIANCE', percent: 12.5 },
      { asset: 'TCS', percent: 10 },
      { asset: 'INFY', percent: 7.5 },
      { asset: 'HDFCBANK', percent: 5 },
      { asset: 'Gold', percent: 3 },
      { asset: 'ITC', percent: 0.5 },
    ]);
    expect(result.total).toBe(38.5);
    expect(result.overAllocated).toBe(false);
  });

  it('keeps asset names with spaces and ignores a middle spreadsheet column', () => {
    const result = parseHoldingsPaste(
      'Cash (liquid fund) 10\nRELIANCE\tReliance Industries Ltd\t20%\r\n',
    );
    expect(result.holdings).toEqual([
      { asset: 'Cash (liquid fund)', percent: 10 },
      { asset: 'RELIANCE', percent: 20 },
    ]);
  });

  it('skips a header row and blank lines', () => {
    const result = parseHoldingsPaste('Symbol\tWeight %\n\nTCS\t10\n');
    expect(result.errors).toEqual([]);
    expect(result.holdings).toEqual([{ asset: 'TCS', percent: 10 }]);
  });

  it('reports the lines it could not read, with their line numbers', () => {
    const result = parseHoldingsPaste('TCS 10\nINFY\nWIPRO abc\nSBIN 140\nLT -2\n,5');
    expect(result.holdings).toEqual([{ asset: 'TCS', percent: 10 }]);
    expect(result.errors.map((error) => [error.line, error.text])).toEqual([
      [2, 'INFY'],
      [3, 'WIPRO abc'],
      [4, 'SBIN 140'],
      [5, 'LT -2'],
      [6, ',5'],
    ]);
    expect(result.errors[3]?.reason).toMatch(/0 to 100/);
  });

  it('sums duplicates and names them', () => {
    const result = parseHoldingsPaste('TCS 10\nINFY 5\nTCS 2.5');
    expect(result.holdings).toEqual([
      { asset: 'TCS', percent: 12.5 },
      { asset: 'INFY', percent: 5 },
    ]);
    expect(result.merged).toEqual(['TCS']);
  });

  it('flags a total over 100 but still returns the rows', () => {
    const result = parseHoldingsPaste('TCS 60\nINFY 50');
    expect(result.holdings).toHaveLength(2);
    expect(result.total).toBe(110);
    expect(result.overAllocated).toBe(true);
  });

  it('fixes case against the known assets only', () => {
    const result = parseHoldingsPaste('reliance 10\nreliance 5\nunknownco 1', ['RELIANCE']);
    expect(result.holdings).toEqual([
      { asset: 'RELIANCE', percent: 15 },
      { asset: 'unknownco', percent: 1 },
    ]);
    expect(result.merged).toEqual(['RELIANCE']);
  });

  it('does not accumulate float noise', () => {
    expect(parseHoldingsPaste('A 0.1\nA 0.2').holdings).toEqual([{ asset: 'A', percent: 0.3 }]);
  });
});

describe('prefill', () => {
  it('turns weights into typed drafts at 2 dp', () => {
    expect(toDrafts([{ asset: 'TCS', percent: 33.3333 }])).toEqual([
      { asset: 'TCS', percent: '33.33' },
    ]);
  });

  it('uses the previewed target, largest first, without cash or zero weights', () => {
    expect(targetAsHoldings({ target_pct: { B: 20, A: 60, 'Idle cash': 20, Gone: 0 } })).toEqual([
      { asset: 'A', percent: '60' },
      { asset: 'B', percent: '20' },
    ]);
  });
});

describe('buildRebalanceTable', () => {
  const trade = (
    asset: string,
    action: 'BUY' | 'SELL',
    current: number,
    target: number,
    ltp: number | null = 100,
  ) => ({
    asset,
    symbol: asset === 'Idle cash' ? null : `NSE:${asset}-EQ`,
    action,
    current_pct: current,
    target_pct: target,
    delta_pct: target - current,
    ltp,
    indicative_value: Math.abs(target - current) * 1000,
    indicative_quantity: ltp ? Math.floor((Math.abs(target - current) * 1000) / ltp) : null,
  });

  const plan = {
    current_pct: { A: 40, B: 20, C: 10, 'Idle cash': 30 },
    target_pct: { A: 20, B: 20, D: 40, 'Idle cash': 20 },
    rows: [
      trade('A', 'SELL', 40, 20),
      trade('C', 'SELL', 10, 0),
      trade('D', 'BUY', 0, 40),
      trade('Idle cash', 'SELL', 30, 20, null),
    ],
  };

  it('merges current and target into one row per asset, sells then buys then holds', () => {
    const table = buildRebalanceTable(plan);
    expect(table.rows.map((row) => [row.asset, row.action])).toEqual([
      ['A', 'SELL'],
      ['C', 'SELL'],
      ['D', 'BUY'],
      ['B', 'HOLD'],
    ]);
  });

  it('gives HOLD rows their weights but no price or trade value', () => {
    const hold = buildRebalanceTable(plan).rows.find((row) => row.asset === 'B');
    expect(hold).toEqual({
      asset: 'B',
      symbol: null,
      currentPct: 20,
      targetPct: 20,
      deltaPct: 0,
      action: 'HOLD',
      price: null,
      value: null,
      quantity: null,
    });
  });

  it('separates cash and totals every row including it', () => {
    const table = buildRebalanceTable(plan);
    expect(table.cash).toMatchObject({ currentPct: 30, targetPct: 20, deltaPct: -10 });
    expect(table.totals).toEqual({
      currentPct: 100,
      targetPct: 100,
      buyValue: 40000,
      sellValue: 30000,
      buys: 1,
      sells: 2,
      holds: 1,
    });
  });

  it('treats a sub-0.01 pp difference with no trade row as HOLD', () => {
    const table = buildRebalanceTable({
      current_pct: { A: 50, 'Idle cash': 50 },
      target_pct: { A: 50.004, 'Idle cash': 49.996 },
      rows: [],
    });
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.action).toBe('HOLD');
    expect(table.cash?.action).toBe('HOLD');
    expect(table.totals.holds).toBe(1);
  });

  it('has no cash row for a fully invested book and drops all-zero assets', () => {
    const table = buildRebalanceTable({
      current_pct: { A: 100, Z: 0 },
      target_pct: { A: 100 },
      rows: [],
    });
    expect(table.cash).toBeNull();
    expect(table.rows.map((row) => row.asset)).toEqual(['A']);
  });
});
