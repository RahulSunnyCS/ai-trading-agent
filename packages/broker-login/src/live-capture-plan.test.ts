import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  type LiveLine,
  type SectionLine,
  type StrategyLine,
  TOOL_PREFIXES,
  algotestBroker,
  algotestLegs,
  algotestLines,
  algotestMultiplier,
  algotestOwnership,
  backfillDays,
  exitCodeFor,
  mergeCapture,
  parseLiveFile,
  quantiplyFills,
  quantiplyLines,
  quantiplyMismatch,
  quantiplyOwned,
  quantiplyRuns,
  quantiplySummaries,
  quantiplyTotal,
  renderLiveFile,
  savedName,
  sectionsToRead,
  toIst,
  toolEnabledFor,
  toolName,
} from './live-capture-plan.js';
import { NAME_PREFIXES } from './strategy-plan.js';

// What the platforms answered on 2026-10-20 (read-only GETs), ids replaced (tests/fixtures/live/).
const FIX = new URL('../../option-backtesting/tests/fixtures/live/', import.meta.url);
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));
const id = (n: number) => n.toString(16).padStart(24, '0');
const NO_LEDGER = algotestOwnership([]);

test('tool names: list, variant, add-on; anything else is not the tool', () => {
  assert.deepEqual(toolName('T1 · N_p150-t1s11_0917'), {
    variant: 'N_p150-t1s11_0917',
    book: 't1',
    addon: false,
  });
  assert.deepEqual(toolName('Core · N_buy_0917 · add-on'), {
    variant: 'N_buy_0917',
    book: 'core',
    addon: true,
  });
  assert.equal(toolName('N_ITM1_SL21_3000'), null);
  assert.equal(toolName('t1 · N_x'), null);
  assert.equal(savedName('T1 · N_p150-t1s11_0917 (2)'), 'T1 · N_p150-t1s11_0917');
  assert.equal(algotestBroker('Broker.Finvasia'), 'finvasia');
  assert.equal(algotestBroker('Broker.AngelOne'), 'angelone');
});

test('every prefix the uploaders use is a tool prefix (the list is append-only)', () => {
  for (const p of NAME_PREFIXES)
    assert.ok(
      TOOL_PREFIXES.some((t) => t.prefix === p),
      p,
    );
});

test('AlgoTest: P&L from the legs, as the web app sums it (sell = entry - exit)', () => {
  const [widesl] = fixture('algotest_exited.json') as { legs: unknown }[];
  const legs = algotestLegs(widesl?.legs);
  // CE 71.6 -> 47.6, PE 58.5 -> 60.75, 65 each: (24 - 2.25) x 65
  assert.equal(legs.pnl, 1413.75);
  assert.equal(legs.open, 0);
  assert.equal(legs.fills.length, 2);
  assert.deepEqual(legs.fills[0]?.entry, { price: 71.6, at: '2026-10-12 13:16:59' });
  // a buy leg counts the other way; a leg still open is not in the P&L
  const buy = algotestLegs([
    {
      position: 'PositionType.Buy',
      status: 2,
      entry_trade: { price: 10, quantity: 75 },
      exit_trade: { price: 14, quantity: 75 },
    },
    { position: 'PositionType.Sell', status: 1, entry_trade: { price: 50, quantity: 75 } },
  ]);
  assert.equal(buy.pnl, 300);
  assert.equal(buy.open, 1);
});

test('AlgoTest: a partial exit counts what was exited and stays open; sums are exact', () => {
  const partial = algotestLegs([
    {
      position: 'PositionType.Sell',
      status: 2,
      entry_trade: { price: 100.1, quantity: 130 },
      exit_trade: { price: 80.2, quantity: 65 },
    },
  ]);
  assert.equal(partial.pnl, 1293.5); // 19.9 x 65, not 19.9 x 130
  assert.equal(partial.open, 1);
  // 0.1 + 0.2 in floats would not be exact
  const exact = algotestLegs([
    {
      position: 'PositionType.Sell',
      status: 2,
      entry_trade: { price: 0.3, quantity: 1 },
      exit_trade: { price: 0.1, quantity: 1 },
    },
    {
      position: 'PositionType.Sell',
      status: 2,
      entry_trade: { price: 0.3, quantity: 1 },
      exit_trade: { price: 0.2, quantity: 1 },
    },
  ]);
  assert.equal(exact.pnl, 0.3);
});

test('AlgoTest: a deploy that spans days counts only the legs that entered on the day read', () => {
  const leg = (at: string, entry: number, exit: number) => ({
    position: 'PositionType.Sell',
    status: 2,
    entry_trade: { price: entry, quantity: 65, exchange_timestamp: at },
    exit_trade: { price: exit, quantity: 65, exchange_timestamp: at },
  });
  const exec = {
    _id: id(50),
    name: 'N_mine_daily (1)',
    broker_type: 'Broker.Finvasia',
    status: 'StrategyStatus.Running',
    creation_ts: '2026-10-19 09:10:00.0',
    // +3,250 on 10-19 (50 points x 65), −650 on 10-20 (−10 points x 65)
    legs: [leg('2026-10-19 09:16:59', 100, 50), leg('2026-10-20 09:16:59', 100, 110)],
  };
  const [d20] = algotestLines('2026-10-20', [[exec]], NO_LEDGER);
  assert.equal(d20?.pnl, -650);
  assert.equal(d20?.fills?.length, 1);
  const [d19] = algotestLines('2026-10-19', [[exec]], NO_LEDGER);
  assert.equal(d19?.pnl, 3250);
  assert.equal(algotestLines('2026-10-21', [[exec]], NO_LEDGER).length, 0);
  // no LotMultiplier anywhere: 1x, said so
  assert.deepEqual([d20?.multiplier, d20?.multiplier_assumed], [1, true]);
});

test('AlgoTest: a leg that never entered is skipped, not counted at price 0', () => {
  const dir = (fixture('algotest_exited.json') as { legs: unknown }[])[1];
  const legs = algotestLegs(dir?.legs);
  assert.equal(legs.fills.length, 2); // the third leg (re-entry) never filled
  assert.equal(legs.pnl, 4397.25);
});

test("AlgoTest: one day's executions only, from either list, each id once", () => {
  const exited = fixture('algotest_exited.json') as unknown[];
  const lines = algotestLines('2026-10-12', [exited, exited.slice(0, 1)], NO_LEDGER);
  assert.deepEqual(
    lines.map((l) => [l.name, l.pnl, l.broker, l.source, l.traded]),
    [
      ['Nifty_Dir_924_ITM1_SL21_RECOST_MTMSL_3000', 4397.25, 'finvasia', 'discretionary', true],
      ['Nifty_Widesl_917_OTM1', 1413.75, 'finvasia', 'discretionary', true],
    ],
  );
  assert.equal(algotestLines('2026-10-13', [exited], NO_LEDGER).length, 1);
  assert.throws(() => algotestLines('2026-10-12', [{}], NO_LEDGER), /not a list/);
});

test('AlgoTest: a deploy with no fills did not trade: no P&L, never a zero', () => {
  const exited = fixture('algotest_exited.json') as unknown[];
  const lines = algotestLines('2026-10-14', [exited], NO_LEDGER);
  assert.deepEqual(
    lines.map((l) => [l.name, l.traded, l.pnl, l.fills?.length]),
    [['S_Widesl_917_otm2', false, null, 0]],
  );
});

test('AlgoTest: the multiplier is the execution settings LotMultiplier', () => {
  assert.equal(algotestMultiplier(fixture('algotest_execution_info.json')), 2);
  const exited = fixture('algotest_exited.json') as { _id: string }[];
  const lines = algotestLines('2026-10-14', [exited], NO_LEDGER, new Map([[id(1), 2]]));
  assert.equal(lines[0]?.multiplier, 2);
});

test("AlgoTest: the tool's by the saved strategy id in its ledger; a same-named copy is the owner's", () => {
  const name = 'T1 · N_p150-t1s11_0917';
  const exec = (strategyId: string, n: number) => ({
    _id: id(100 + n),
    name: `${name} (${n})`,
    broker_type: 'Broker.Finvasia',
    status: 'StrategyStatus.SquaredOff',
    strategy_id: strategyId,
    creation_ts: '2026-10-21 09:16:30.0',
    legs: [],
  });
  const own = algotestOwnership([
    { action: 'upload', ok: true, name, id: id(7) },
    { action: 'upload', ok: false, name: 'T1 · N_failed_0917', id: id(8) },
    // an id under a name no prefix knows (a later rename) is still the tool's
    { action: 'upload', ok: true, name: 'XX · N_renamed_0917', id: id(9) },
  ]);
  const lines = algotestLines('2026-10-21', [[exec(id(7), 1), exec(id(10), 2)]], own);
  assert.deepEqual(
    lines.map((l) => [l.platform_id, l.source, l.variant, l.book]),
    [
      [id(101), 'tool', 'N_p150-t1s11_0917', 't1'],
      [id(102), 'discretionary', null, null],
    ],
  );
  assert.ok(own.ids.has(id(9)) && !own.ids.has(id(8)));
  // an upload from before ids were recorded is matched by its name
  const old = algotestOwnership([{ action: 'upload', ok: true, name }]);
  assert.equal(algotestLines('2026-10-21', [[exec(id(10), 1)]], old)[0]?.source, 'tool');
});

test("Quantiply: each algo's runs from the account chart add up to its total", () => {
  const pages = [fixture('quantiply_pnl_account.json')];
  const runs = quantiplyRuns(pages);
  assert.equal(runs.size, 6);
  const sum = [...runs.values()].reduce((s, v) => s + v.pnl, 0);
  assert.equal(Math.round(sum * 100) / 100, quantiplyTotal(pages));
  assert.equal(quantiplyTotal(pages), -3675.75);
  assert.equal(quantiplyMismatch(runs, quantiplyTotal(pages)), null);
});

test('Quantiply: two runs of one algo in a day are added, not the last one kept', () => {
  const page = {
    metaData: {
      totalMTM: 500,
      lastValues: {
        r1: { algo: id(1), state: 'r1', c: 1500, t: '2026-10-15T05:00:00Z' },
        r2: { algo: id(1), state: 'r2', c: -1000, t: '2026-10-15T09:00:00Z' },
      },
    },
  };
  // the same run again on a later page replaces, never adds
  const later = { metaData: { lastValues: { r2: { algo: id(1), state: 'r2', c: -900, t: 'x' } } } };
  assert.deepEqual(quantiplyRuns([page]).get(id(1)), { pnl: 500, runs: 2 });
  assert.deepEqual(quantiplyRuns([page, later]).get(id(1)), { pnl: 600, runs: 2 });
  // not matching the chart's total beyond rounding fails the section
  assert.match(quantiplyMismatch(quantiplyRuns([page, later]), 500) ?? '', /add up to 600.00/);
  assert.equal(quantiplyMismatch(quantiplyRuns([page]), 500.4), null);
});

test('Quantiply: names and multipliers from the day-wise list, the tool by its ledger', () => {
  const summaries = quantiplySummaries(fixture('quantiply_day_wise.json'));
  assert.equal(summaries.filter((s) => s.day === 'MON').length, 8);
  const runs = quantiplyRuns([fixture('quantiply_pnl_account.json')]);
  const [first] = [...runs.keys()];
  assert.ok(first);
  // pretend the uploader made the first one, and one more that is gone from the list
  const gone = id(999);
  runs.set(gone, { pnl: -120, runs: 1 });
  const owned = quantiplyOwned([
    { action: 'create', ok: true, id: first, name: 'Core · N_p100_1202' },
    { action: 'create', ok: true, id: gone, name: 'Core · N_wide_1117' },
    { action: 'create', ok: false, id: id(998), name: 'Core · x' },
  ]);
  const lines = quantiplyLines('2026-10-19', 'angelone', summaries, runs, owned);
  assert.equal(lines.length, 7);
  const mine = lines.filter((l) => l.source === 'tool');
  assert.deepEqual(
    mine.map((l) => [l.platform_id, l.multiplier]).sort(),
    [
      [first, 1],
      [gone, 1],
    ].sort(),
  );
  assert.equal(lines.find((l) => l.platform_id === gone)?.variant, 'N_wide_1117');
  assert.ok(lines.filter((l) => l.source === 'discretionary').every((l) => l.variant === null));
  assert.ok(lines.every((l) => l.pnl_source === 'pnl-chart' && l.traded));
});

test('Quantiply: an algo the tool switched on for the day with no run did not trade', () => {
  const summaries = [
    {
      id: id(1),
      name: 'Core · N_wide_1117',
      day: 'WED',
      enabled: false,
      multiplier: 1,
      status: 'ERROR',
    },
    { id: id(2), name: 'N_mine', day: 'WED', enabled: true, multiplier: 1, status: 'NOT_RUNNING' },
  ];
  const owned = new Map([[id(1), 'Core · N_wide_1117']]);
  // the deploy ledger: enabled for the session (then switched off by the 15:40 safety net, which
  // does not count), one enabled and switched off again before the session, another session
  const enabled = toolEnabledFor(
    [
      { session: '2026-10-21', mode: 'enable', action: 'enable', id: id(1), ok: true },
      { session: '2026-10-21', mode: 'disable', action: 'disable', id: id(1), ok: true },
      { session: '2026-10-21', mode: 'enable', action: 'enable', id: id(4), ok: true },
      { session: '2026-10-21', mode: 'enable', action: 'disable', id: id(4), ok: true },
      { session: '2026-10-22', mode: 'enable', action: 'enable', id: id(5), ok: true },
      { session: '2026-10-21', mode: 'enable', action: 'enable', id: id(6), ok: false },
    ],
    '2026-10-21',
  );
  assert.deepEqual([...enabled], [id(1)]);
  const lines = quantiplyLines(
    '2026-10-21',
    'angelone',
    summaries,
    new Map(),
    owned,
    new Map(),
    enabled,
  );
  // the same answer before or after the disable: `enabled` in the list is not read
  assert.deepEqual(
    lines.map((l) => [l.platform_id, l.traded, l.pnl, l.source]),
    [[id(1), false, null, 'tool']],
  );
});

test('Quantiply: a position with no exit is an open leg; an algo gone from the list is 1x assumed', () => {
  const runs = new Map([
    [id(1), { pnl: -900, runs: 1 }],
    [id(2), { pnl: 100, runs: 1 }],
  ]);
  const positions = new Map([
    [
      id(1),
      {
        data: {
          state: {
            positions: [
              { transactionType: 'S', quantity: 65, entryPrice: 100, exitPrice: 90 },
              { transactionType: 'S', quantity: 65, entryPrice: 100 },
            ],
          },
        },
      },
    ],
  ]);
  const summaries = [
    { id: id(1), name: 'N_x', day: 'WED', enabled: true, multiplier: 2, status: 'TRADE_CLOSED' },
  ];
  const lines = quantiplyLines('2026-10-21', 'angelone', summaries, runs, new Map(), positions);
  const [open, gone] = [
    lines.find((l) => l.platform_id === id(1)),
    lines.find((l) => l.platform_id === id(2)),
  ];
  assert.equal(open?.open_legs, 1);
  assert.equal(open?.multiplier, 2);
  assert.equal(open?.multiplier_assumed, undefined);
  assert.deepEqual([gone?.multiplier, gone?.multiplier_assumed], [1, true]);
});

test('Quantiply: fills only from a state whose fields are plain, times read as UTC into IST', () => {
  assert.equal(quantiplyFills(fixture('quantiply_day_wise.json')), null);
  assert.equal(quantiplyFills({ data: { state: null } }), null);
  assert.deepEqual(
    quantiplyFills({
      data: {
        state: {
          positions: [
            {
              transactionType: 'S',
              quantity: 65,
              entryPrice: 100,
              exitPrice: 80,
              symbol: 'NIFTY…CE',
              entryTime: '2026-10-21T03:46:59.000Z',
              exitTime: '2026-10-21T09:58:00Z',
            },
          ],
        },
      },
    }),
    [
      {
        leg: '',
        symbol: 'NIFTY…CE',
        side: 'S',
        qty: 65,
        entry: { price: 100, at: '2026-10-21 09:16:59' },
        exit: { price: 80, qty: 65, at: '2026-10-21 15:28:00' },
      },
    ],
  );
  assert.equal(quantiplyFills({ data: { state: { positions: [{ side: 'CE' }] } } }), null);
  assert.equal(toIst('2026-10-12 13:16:59'), '2026-10-12 13:16:59'); // AlgoTest's: already IST
  assert.equal(toIst('2026-10-21T03:46:59+00:00'), '2026-10-21 09:16:59');
});

const sectionLine = (
  platform: 'algotest' | 'quantiply',
  broker: string,
  ok: boolean,
  kind: 'retry' | 'config' | null = ok ? null : 'retry',
  day = '2026-10-21',
): SectionLine => ({
  kind: 'section',
  day,
  platform,
  broker: broker as SectionLine['broker'],
  ok,
  error: ok ? null : 'login failed',
  error_kind: kind,
  strategies: 0,
  captured_at: '2026-10-21T10:10:00Z',
});
const strategyLine = (
  platform: 'algotest' | 'quantiply',
  broker: string,
  name: string,
): StrategyLine => ({
  kind: 'strategy',
  day: '2026-10-21',
  platform,
  broker,
  name,
  variant: null,
  book: null,
  addon: false,
  source: 'discretionary',
  platform_id: id(1),
  multiplier: 1,
  traded: true,
  pnl: 100,
  status: null,
  open_legs: 0,
  fills: null,
  pnl_source: 'legs',
});

test('the day file: a re-run replaces what it read and keeps a section it could not read', () => {
  const before: LiveLine[] = [
    sectionLine('algotest', 'all', true),
    strategyLine('algotest', 'finvasia', 'old AlgoTest'),
    sectionLine('quantiply', 'angelone', true),
    strategyLine('quantiply', 'angelone', 'old Quantiply'),
  ];
  const merged = mergeCapture(before, [
    {
      section: sectionLine('algotest', 'all', true),
      strategies: [strategyLine('algotest', 'finvasia', 'new')],
    },
    { section: sectionLine('quantiply', 'angelone', false), strategies: [] },
  ]);
  const names = merged.filter((l): l is StrategyLine => l.kind === 'strategy').map((l) => l.name);
  assert.deepEqual(names, ['new', 'old Quantiply']);
  // the file round-trips, a torn line is skipped
  const text = `${renderLiveFile(merged)}{"kind":"strat`;
  assert.deepEqual(parseLiveFile(text), merged);
});

test('a retry reads only the sections not read yet (no second login to an account read)', () => {
  const wanted = ['algotest.all', 'quantiply.angelone'];
  assert.deepEqual(sectionsToRead(null, wanted), wanted);
  const lines = [sectionLine('algotest', 'all', false), sectionLine('quantiply', 'angelone', true)];
  assert.deepEqual(sectionsToRead(lines, wanted), ['algotest.all']);
  assert.deepEqual(sectionsToRead(lines, wanted, true), wanted);
});

test('exit: 0 all read, 1 a retry may help, 3 only config problems (one alert, no retry)', () => {
  assert.equal(exitCodeFor([sectionLine('algotest', 'all', true)]), 0);
  assert.equal(exitCodeFor([sectionLine('algotest', 'all', false, 'config')]), 3);
  assert.equal(
    exitCodeFor([
      sectionLine('algotest', 'all', false, 'config'),
      sectionLine('quantiply', 'angelone', false, 'retry'),
    ]),
    1,
  );
});

test("back-fill: the last 5 trading days that miss a section, from the capture's first day", () => {
  const wanted = ['algotest.all'];
  const trading = (d: string) => !['2026-10-20', '2026-10-24', '2026-10-25'].includes(d);
  const ok = (day: string) => [sectionLine('algotest', 'all', true, null, day)];
  const files = new Map<string, LiveLine[]>([
    ['2026-10-19', ok('2026-10-19')],
    ['2026-10-22', [sectionLine('algotest', 'all', false, 'retry', '2026-10-22')]],
  ]);
  // Mon 26: Fri 23 (no file), Thu 22 (failed) miss; Wed 21 had no file either; Mon 19 is fine;
  // Tue 20 is a holiday; nothing before the first day (19) counts
  assert.deepEqual(backfillDays('2026-10-26', '2026-10-19', files, wanted, trading), [
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
  ]);
  assert.deepEqual(backfillDays('2026-10-26', null, files, wanted, trading), []);
  assert.deepEqual(backfillDays('2026-10-26', '2026-10-19', files, wanted, trading, 2), [
    '2026-10-22',
    '2026-10-23',
  ]);
});
