/**
 * The Trade book's view logic (BL-168). Every account id and figure here is invented.
 */

import { describe, expect, it } from 'vitest';

import type {
  TradeBookDay,
  TradeBookDayDetail,
  TradeBookSummaryBlock,
  TradeBookTrip,
} from '../../types/tradeBook';
import {
  accountLabel,
  algoFee,
  benchmarkKey,
  contractLabel,
  dayChargeParts,
  dayState,
  eventAmount,
  eventsFor,
  filterTrips,
  fiscalYearOf,
  fyLabel,
  fyOptions,
  fyRange,
  gapTone,
  headlineTiles,
  heatClass,
  heldLabel,
  heldText,
  inputsBody,
  inputsDraft,
  kiteTotals,
  lastYearLine,
  maskAccountId,
  moneyTotals,
  monthCells,
  monthLabel,
  monthRange,
  orderSources,
  paceFraction,
  parseBenchmark,
  parseFy,
  readQuery,
  runningBook,
  scatterPoints,
  sourceCards,
  sourcesByDay,
  targetLine,
  tripMonths,
  tripTimes,
  yearChargeParts,
  yearEarlier,
  yearFraction,
} from '../tradeBookView';

function day(d: string, profit: number | null, extra: Partial<TradeBookDay> = {}): TradeBookDay {
  return {
    day: d,
    notes: profit === null ? 0 : 1,
    open: 0,
    net: profit,
    note_charges: profit === null ? null : 10,
    algos: null,
    algo_fees: 0,
    profit,
    charges: profit === null ? null : 10,
    capital: 100_000,
    capital_source: 'manual',
    interest: 0,
    deposits: 0,
    withdrawals: 0,
    cumulative: 0,
    drawdown: 0,
    avg_profit_50: null,
    avg_profit_100: null,
    avg_charges_100: null,
    charge_profit_pct: null,
    avg_capital_100: null,
    profit_capital_bps: null,
    ...extra,
  };
}

function summary(extra: Partial<TradeBookSummaryBlock> = {}): TradeBookSummaryBlock {
  return {
    first_day: '2026-04-01',
    last_day: '2026-09-30',
    sessions: 120,
    traded_sessions: 110,
    net: 10_000,
    charges: 3_000,
    note_charges: 2_500,
    algo_fees: 500,
    interest: 200,
    charge_profit_pct: 30,
    max_drawdown: -4_000,
    max_drawdown_pct: -4,
    longest_drawdown: 12,
    win_days: 60,
    loss_days: 50,
    win_pct: 54.5,
    avg_day: 90.9,
    avg_win: 400,
    avg_loss: -280,
    best: 1_500,
    worst: -1_200,
    capital: 100_000,
    profit_pct: 10,
    time_weighted_return_pct: 10.4,
    deposits: 0,
    withdrawals: 0,
    ...extra,
  };
}

function trip(extra: Partial<TradeBookTrip> = {}): TradeBookTrip {
  return {
    day: '2026-10-21',
    entry_day: '2026-10-21',
    broker: 'finvasia',
    account: 'XX0001',
    underlying: 'NIFTY',
    instrument: 'OPTIDX',
    expiry: '2026-10-27',
    strike: 25000,
    kind: 'PE',
    direction: 'short',
    qty: 75,
    entry_time: '09:17:05',
    exit_time: '11:02:40',
    entry_price: 40,
    exit_price: 30,
    pnl: 750,
    charges: 20,
    status: 'closed',
    fills: 2,
    source_check: 'fills',
    dte: 4,
    turnover: 5250,
    net: 730,
    holding_minutes: 105,
    source: 'adaptive-core',
    strategy: null,
    mae: -300,
    mfe: 1000,
    spot_at_entry: 25010,
    strike_from_spot: -10,
    ...extra,
  };
}

describe('financial years', () => {
  it('starts in April', () => {
    expect(fiscalYearOf('2026-04-01')).toBe(2026);
    expect(fiscalYearOf('2026-03-31')).toBe(2025);
    expect(fyLabel(2025)).toBe('FY 2025-26');
    expect(fyRange(2025)).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(parseFy('2025-26')).toBe(2025);
    expect(parseFy('2025')).toBe(2025);
    expect(parseFy('x')).toBeNull();
  });

  it('measures the share of the year passed, the last day included', () => {
    expect(yearFraction('2025-04-01')).toBeCloseTo(1 / 365, 6);
    expect(yearFraction('2026-03-31')).toBe(1);
    expect(yearFraction('2027-03-31')).toBe(1); // a 366-day year ends at 1 too
  });

  it('offers every stored year and the current one, newest first', () => {
    expect(fyOptions(['2024-25', '2025-26'], '2026-10-27')).toEqual([2026, 2025, 2024]);
    expect(fyOptions([], '2027-04-02')).toEqual([2027]);
  });

  it('steps back a year, 29 Feb landing on 28 Feb', () => {
    expect(yearEarlier('2026-10-23')).toBe('2025-10-23');
    expect(yearEarlier('2028-02-29')).toBe('2027-02-28');
  });
});

describe('accounts and sources', () => {
  it('hides the middle of an account id and numbers a second account of a broker', () => {
    expect(maskAccountId('AB1234')).toBe('AB··34');
    expect(maskAccountId('A12')).toBe('A12');
    const all = ['angelone/ZZ9999', 'finvasia/XX0001', 'finvasia/YY0002'];
    expect(accountLabel('finvasia/XX0001', all)).toBe('Finvasia · XX··01');
    expect(accountLabel('finvasia/YY0002', all)).toBe('Finvasia 2 · YY··02');
    expect(accountLabel('angelone/ZZ9999', all)).toBe('Angel One · ZZ··99');
    expect(accountLabel('angelone/', all)).toBe('Angel One');
  });

  it('orders the known sources first', () => {
    expect(orderSources(['manual', 'zzz', 't1', 'adaptive-core', 't1'])).toEqual([
      'adaptive-core',
      't1',
      'manual',
      'zzz',
    ]);
  });
});

describe('the sheet algo fee', () => {
  it.each([
    [null, 0],
    [0, 0],
    [1, 38],
    [3, 63],
    [4, 75],
    [10, 150],
  ])('%s algos -> %s', (algos, fee) => {
    expect(algoFee(algos)).toBe(fee);
  });
});

describe('running figures', () => {
  it('restarts to date and drawdown at the range start and skips a no-note day', () => {
    const book = runningBook([
      day('2026-04-01', 100),
      day('2026-04-02', -300),
      day('2026-04-03', null),
      day('2026-04-06', 500),
    ]);
    expect(book.map((b) => b.toDate)).toEqual([100, -200, -200, 300]);
    expect(book.map((b) => b.drawdown)).toEqual([0, -300, -300, 0]);
    expect(book[2]?.profit).toBeNull();
  });

  it('draws a target pace from capital, rate and the year passed', () => {
    const line = targetLine(['2025-04-01', '2026-03-31'], 100_000, 24);
    expect(line.at(-1)).toEqual({ day: '2026-03-31', value: 24_000 });
    expect(targetLine(['2026-03-31'], null, 24)).toEqual([]);
    expect(targetLine([], 100_000, 24)).toEqual([]);
  });

  it("starts the pace at the year's first session", () => {
    expect(paceFraction('2025-04-01', '2026-03-31')).toBe(1);
    expect(paceFraction('2025-03-01', '2025-04-01')).toBeCloseTo(1 / 365, 6); // never before 1 Apr
    const late = targetLine(['2025-10-01', '2025-10-02'], 365_000, 10);
    expect(late[0]?.value).toBeCloseTo(100, 6); // one day of the year, not six months
    expect(late[1]?.value).toBeCloseTo(200, 6);
  });

  it('sums the running figures in whole paise', () => {
    const book = runningBook([
      day('2026-04-01', 0.1),
      day('2026-04-02', 0.2),
      day('2026-04-03', 2023.38),
    ]);
    expect(book.map((b) => b.toDate)).toEqual([0.1, 0.3, 2023.68]);
  });

  it('lays last year on this year by calendar day', () => {
    const last = runningBook([day('2025-04-01', 100), day('2025-04-03', 50)]);
    expect(lastYearLine(['2026-04-01', '2026-04-02', '2026-04-03'], last)).toEqual([
      { day: '2026-04-01', value: 100 },
      { day: '2026-04-02', value: 100 },
      { day: '2026-04-03', value: 150 },
    ]);
    expect(lastYearLine(['2026-03-31'], last)).toEqual([]);
  });
});

describe('the headline', () => {
  it('compares net and return with a target pace and gives the rest no figure', () => {
    const s = summary({
      first_day: '2025-04-01',
      last_day: '2026-03-31',
      net: 20_000,
      profit_pct: 20,
      capital: 100_000,
    });
    const tiles = headlineTiles(s, parseBenchmark(null), null);
    const net = tiles.find((t) => t.id === 'net');
    expect(net?.bench).toBe(24_000);
    expect(net?.gap).toBe(-4_000);
    expect(gapTone(net ?? tiles[0]!)).toBe('negative');
    const ret = tiles.find((t) => t.id === 'return');
    expect(ret?.bench).toBe(24);
    expect(ret?.gap).toBe(-4);
    expect(tiles.find((t) => t.id === 'drawdown')?.bench).toBeNull();
    expect(tiles.find((t) => t.id === 'win')?.gap).toBeNull();
  });

  it('compares every tile with last FY, lower charges being better', () => {
    const s = summary({ charge_profit_pct: 30, max_drawdown: -4_000 });
    const ly = summary({ charge_profit_pct: 40, max_drawdown: -6_000, net: 8_000 });
    const tiles = headlineTiles(s, parseBenchmark('lastfy'), ly);
    const charges = tiles.find((t) => t.id === 'charges');
    expect(charges?.gap).toBe(-10);
    expect(gapTone(charges ?? tiles[0]!)).toBe('positive');
    const dd = tiles.find((t) => t.id === 'drawdown');
    expect(dd?.gap).toBe(2_000);
    expect(gapTone(dd ?? tiles[0]!)).toBe('positive');
    expect(tiles.find((t) => t.id === 'net')?.gap).toBe(2_000);
  });

  it('gives charges / net profit no colour when either year lost money', () => {
    const losing = summary({ net: -5_000, charge_profit_pct: -50 });
    const ly = summary({ charge_profit_pct: 25 });
    const charges = headlineTiles(losing, parseBenchmark('lastfy'), ly).find(
      (t) => t.id === 'charges',
    );
    expect(charges?.gap).toBe(-75);
    expect(gapTone(charges!)).toBe('neutral');
    const lyLost = summary({ net: -1, charge_profit_pct: -10 });
    const c2 = headlineTiles(summary(), parseBenchmark('lastfy'), lyLost).find(
      (t) => t.id === 'charges',
    );
    expect(gapTone(c2!)).toBe('neutral');
  });

  it('reads and writes the benchmark key', () => {
    expect(parseBenchmark(null)).toEqual({ id: 'pace', ratePct: 24 });
    expect(parseBenchmark('pace30')).toEqual({ id: 'pace', ratePct: 30 });
    expect(parseBenchmark('pace99')).toEqual({ id: 'pace', ratePct: 24 });
    expect(benchmarkKey(parseBenchmark('lastfy'))).toBe('lastfy');
    expect(benchmarkKey(parseBenchmark('pace18'))).toBe('pace18');
  });
});

describe('day states', () => {
  it('names notes, a failed note and no note, never a zero', () => {
    expect(dayState({ notes: 3, open: 0 })).toEqual({ kind: 'notes', label: '3 notes' });
    expect(dayState({ notes: 1, open: 0 }).label).toBe('1 note');
    expect(dayState({ notes: 0, open: 0 })).toEqual({ kind: 'no-note', label: 'no note' });
    expect(dayState({ notes: 2, open: 1 })).toEqual({ kind: 'open', label: '2 read · 1 failed' });
  });
});

describe('months', () => {
  it('lays April to March with the rows it has', () => {
    const cells = monthCells(2026, [
      {
        month: '2026-04',
        profit: 100,
        charges: 5,
        sessions: 20,
        capital: 1e5,
        pct: 0.1,
        avg3_pct: null,
      },
      {
        month: '2027-01',
        profit: -50,
        charges: 5,
        sessions: 19,
        capital: 1e5,
        pct: -0.05,
        avg3_pct: 0.02,
      },
    ]);
    expect(cells).toHaveLength(12);
    expect(cells[0]?.label).toBe("Apr '26");
    expect(cells[0]?.data?.profit).toBe(100);
    expect(cells[9]?.month).toBe('2027-01');
    expect(cells[9]?.data?.profit).toBe(-50);
    expect(cells[11]?.label).toBe("Mar '27");
    expect(cells[1]?.data).toBeNull();
  });

  it('tints by sign and strength', () => {
    expect(heatClass(null, 5)).toBe('bg-surface-2');
    expect(heatClass(5, 5)).toBe('bg-positive/30');
    expect(heatClass(-1, 5)).toBe('bg-negative/10');
  });
});

describe('charges by kind', () => {
  it('splits the year into note charges, algo fees and interest', () => {
    // A day with algos and no note has its fee in algo_fees but not in charges: the notes'
    // part is the API's note_charges, not charges − algo fees (2,350 here).
    const parts = yearChargeParts(
      summary({ charges: 2_850, note_charges: 2_500, algo_fees: 500, interest: 200 }),
    );
    expect(parts.map((p) => [p.key, p.amount])).toEqual([
      ['notes', 2_500],
      ['algo', 500],
      ['interest', 200],
    ]);
  });

  it("adds a day's itemised charges, its algo fees and its interest", () => {
    const detail = {
      day: '2026-10-21',
      row: day('2026-10-21', 900, { algo_fees: 75 }),
      lines: [
        {
          day: '2026-10-21',
          broker: 'finvasia',
          account: 'XX0001',
          status: 'note',
          trades: 4,
          charges: { brokerage: 20, stt: 30, transaction: 5 },
        },
        {
          day: '2026-10-21',
          broker: 'angelone',
          account: 'ZZ9999',
          status: 'note',
          trades: 2,
          charges: { brokerage: 10, exchange: 3 },
        },
        { day: '2026-10-21', broker: 'finvasia', account: 'YY0002', status: 'no_trade', trades: 0 },
      ],
      trips: [],
      ledger: [
        {
          day: '2026-10-21',
          broker: 'angelone',
          account: 'ZZ9999',
          kind: 'collateral_interest',
          amount: 42,
        },
      ],
      manual: { algos: 4 },
      context: { day: '2026-10-21', vix_open: null, vix_pct: null, indices: {} },
    } as TradeBookDayDetail;
    expect(dayChargeParts(detail).map((p) => [p.key, p.amount])).toEqual([
      ['brokerage', 30],
      ['stt', 30],
      ['exchange', 8],
      ['algo', 75],
      ['interest', 42],
    ]);
  });
});

describe('trips', () => {
  const trips = [
    trip(),
    trip({
      source: 'manual',
      underlying: 'SENSEX',
      dte: 0,
      pnl: -200,
      net: -210,
      mae: -500,
      mfe: 100,
    }),
    trip({ source: 'manual', dte: 5, pnl: 300, net: 280, mae: null, mfe: null }),
    trip({ source: 't1', status: 'open', pnl: null, net: null }),
  ];

  it('filters by source, index and days to expiry', () => {
    expect(filterTrips(trips, { source: 'manual', index: null, dte: null })).toHaveLength(2);
    expect(filterTrips(trips, { source: null, index: 'SENSEX', dte: null })).toHaveLength(1);
    expect(filterTrips(trips, { source: null, index: null, dte: '3+' })).toHaveLength(3);
    expect(filterTrips(trips, { source: null, index: null, dte: '0' })).toHaveLength(1);
  });

  it('cards each source, open trips apart', () => {
    const cards = sourceCards(trips);
    expect(cards.map((c) => c.source)).toEqual(['adaptive-core', 't1', 'manual']);
    const manual = cards.find((c) => c.source === 'manual');
    expect(manual).toMatchObject({ trips: 2, net: 70, won: 1, winPct: 50, avg: 35, open: 0 });
    expect(cards.find((c) => c.source === 't1')).toMatchObject({ trips: 0, open: 1, avg: null });
  });

  it('plots only trips with a best and worst point, capping the share kept', () => {
    const points = scatterPoints(trips);
    expect(points.map((p) => [p.mae, p.kept])).toEqual([
      [-300, 75],
      [-500, -100],
    ]);
  });

  it('labels a contract, its times and how long it was held', () => {
    expect(contractLabel(trip())).toBe('NIFTY 27 Oct 25000 PE');
    expect(tripTimes(trip())).toBe('09:17–11:02');
    expect(tripTimes(trip({ exit_time: null }))).toBe('09:17');
    expect(heldText(105)).toBe('1h 45m');
    expect(heldText(39)).toBe('39m');
    expect(heldText(null)).toBeNull();
  });

  it('says overnight for a trip that closed on a later day', () => {
    expect(heldLabel(trip())).toBe('1h 45m');
    expect(heldLabel(trip({ entry_day: '2026-10-20', holding_minutes: null }))).toBe('overnight');
    expect(heldLabel(trip({ holding_minutes: null }))).toBeNull();
  });

  it('reads a month as a range of at most 31 days and lists the months with trips', () => {
    expect(monthRange('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthLabel('2026-10')).toBe("Oct '26");
    expect(tripMonths([trip(), trip({ day: '2026-09-30' }), trip()])).toEqual([
      { month: '2026-10', trips: 2 },
      { month: '2026-09', trips: 1 },
    ]);
  });

  it('collects the sources of each day', () => {
    expect(sourcesByDay(trips).get('2026-10-21')).toEqual(['adaptive-core', 't1', 'manual']);
  });
});

describe('money', () => {
  const events = [
    { day: '2026-10-01', broker: 'angelone', account: 'ZZ9999', kind: 'deposit', amount: 50_000 },
    {
      day: '2026-10-05',
      broker: 'finvasia',
      account: 'XX0001',
      kind: 'settlement',
      amount: 10_000,
    },
    {
      day: '2026-10-06',
      broker: 'angelone',
      account: 'ZZ9999',
      kind: 'collateral_interest',
      amount: 40,
    },
    {
      day: '2026-10-07',
      broker: 'angelone',
      account: 'ZZ9999',
      kind: 'collateral_interest',
      amount: 60,
    },
    {
      day: '2026-10-08',
      broker: 'angelone',
      account: 'ZZ9999',
      kind: 'margin_warning',
      utilisation_pct: 97.5,
    },
    {
      day: '2026-10-09',
      broker: 'angelone',
      account: 'ZZ9999',
      kind: 'margin_warning',
      utilisation_pct: 80,
    },
    { day: '2026-10-10', broker: 'kite', account: 'KK0003', kind: 'deposit', amount: 9_999 },
  ];

  it('totals the ledger', () => {
    expect(moneyTotals(eventsFor(events, null))).toMatchObject({
      deposits: 50_000,
      depositCount: 1,
      settlements: 1,
      interest: 100,
      interestDays: 2,
      marginWarnings: 2,
      marginHigh: 1,
    });
  });

  it("keeps one account's events and signs money out", () => {
    expect(eventsFor(events, 'finvasia/XX0001')).toHaveLength(1);
    expect(eventsFor(events, null)).toHaveLength(6); // the Zerodha deposit is Momentum's
    expect(eventAmount(events[0]!)).toBe(50_000);
    expect(eventAmount(events[2]!)).toBe(-40);
    expect(eventAmount(events[4]!)).toBeNull();
  });
});

describe('the inputs dialog', () => {
  it('sends only what changed, a cleared field as null', () => {
    const manual = { algos: 4, capital_total: 200_000, capital: { angelone: 90_000 } };
    const draft = inputsDraft(manual);
    expect(draft).toEqual({ algos: '4', capitalTotal: '200000', finvasia: '', angelone: '90000' });
    expect(inputsBody(manual, draft)).toEqual({ body: {}, errors: {}, changed: false });
    const next = inputsBody(manual, {
      ...draft,
      algos: '9',
      capitalTotal: '',
      finvasia: '1,10,000',
    });
    expect(next.body).toEqual({ algos: 9, capital_total: null, capital: { finvasia: 110_000 } });
    expect(next.changed).toBe(true);
  });

  it('rounds an imported amount to the paisa and does not send it back untouched', () => {
    const manual = { capital_total: 123_456.789 };
    const draft = inputsDraft(manual);
    expect(draft.capitalTotal).toBe('123456.79');
    expect(inputsBody(manual, draft)).toEqual({ body: {}, errors: {}, changed: false });
    const typed = inputsBody(null, { ...draft, finvasia: '1000.555' });
    expect(typed.errors).toEqual({});
    expect(typed.body.capital).toEqual({ finvasia: 1000.56 });
  });

  it('refuses a bad number', () => {
    const check = inputsBody(null, {
      algos: '2.5',
      capitalTotal: '-1',
      finvasia: 'abc',
      angelone: '',
    });
    expect(Object.keys(check.errors).sort()).toEqual(['algos', 'capitalTotal', 'finvasia']);
  });
});

describe('momentum and queries', () => {
  it('adds up the Zerodha notes', () => {
    const t = kiteTotals([
      {
        eq: { total_charges: 12 },
        trades: [
          { side: 'buy', value: -1_000 },
          { side: 'buy', value: -500 },
        ],
      },
      { eq: null, trades: [{ side: 'sell', value: 700 }] },
    ]);
    expect(t).toEqual({ bought: 1_500, buys: 2, sold: 700, sells: 1, charges: 12, notes: 2 });
  });

  it('builds a read query from the parts that are set', () => {
    expect(readQuery({ from: '2026-04-01', to: null, account: 'finvasia/XX0001' })).toBe(
      '?from=2026-04-01&account=finvasia%2FXX0001',
    );
    expect(readQuery({ from: null })).toBe('');
  });
});
