import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  type LiveLine,
  type SectionLine,
  type StrategyLine,
  algotestBroker,
  algotestLegs,
  algotestLines,
  algotestMultiplier,
  algotestOwnership,
  captureCovers,
  mergeCapture,
  parseLiveFile,
  quantiplyFills,
  quantiplyLastValues,
  quantiplyLines,
  quantiplyOwned,
  quantiplySummaries,
  quantiplyTotal,
  renderLiveFile,
  savedName,
  toolName,
} from './live-capture-plan.js';

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
    lines.map((l) => [l.name, l.pnl, l.broker, l.source]),
    [
      ['Nifty_Dir_924_ITM1_SL21_RECOST_MTMSL_3000', 4397.25, 'finvasia', 'discretionary'],
      ['Nifty_Widesl_917_OTM1', 1413.75, 'finvasia', 'discretionary'],
    ],
  );
  assert.equal(algotestLines('2026-10-13', [exited], NO_LEDGER).length, 1);
  // a deploy that never traded is listed with 0 (it ran, nothing filled)
  const noLegs = algotestLines('2026-10-14', [exited], NO_LEDGER);
  assert.deepEqual(
    noLegs.map((l) => [l.name, l.pnl, l.fills?.length]),
    [['S_Widesl_917_otm2', 0, 0]],
  );
  assert.throws(() => algotestLines('2026-10-12', [{}], NO_LEDGER), /not a list/);
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
  ]);
  const lines = algotestLines('2026-10-21', [[exec(id(7), 1), exec(id(9), 2)]], own);
  assert.deepEqual(
    lines.map((l) => [l.platform_id, l.source, l.variant, l.book]),
    [
      [id(101), 'tool', 'N_p150-t1s11_0917', 't1'],
      [id(102), 'discretionary', null, null],
    ],
  );
  // an upload from before ids were recorded is matched by its name
  const old = algotestOwnership([{ action: 'upload', ok: true, name }]);
  assert.equal(algotestLines('2026-10-21', [[exec(id(9), 1)]], old)[0]?.source, 'tool');
});

test("Quantiply: each algo's closing MTM from the account chart adds up to its total", () => {
  const pages = [fixture('quantiply_pnl_account.json')];
  const last = quantiplyLastValues(pages);
  assert.equal(last.size, 6);
  const sum = [...last.values()].reduce((s, v) => s + v.pnl, 0);
  assert.equal(Math.round(sum * 100) / 100, quantiplyTotal(pages));
  assert.equal(quantiplyTotal(pages), -3675.75);
});

test('Quantiply: a later page wins for the same algo', () => {
  const page = (c: number, t: string) => ({
    metaData: { lastValues: { s: { algo: id(1), c, t } } },
  });
  const last = quantiplyLastValues([
    page(10, '2026-10-19T04:00:00Z'),
    page(25, '2026-10-19T09:00:00Z'),
  ]);
  assert.equal(last.get(id(1))?.pnl, 25);
});

test('Quantiply: names and multipliers from the day-wise list, the tool by its ledger', () => {
  const summaries = quantiplySummaries(fixture('quantiply_day_wise.json'));
  assert.equal(summaries.filter((s) => s.day === 'MON').length, 8);
  const last = quantiplyLastValues([fixture('quantiply_pnl_account.json')]);
  const [first] = [...last.keys()];
  assert.ok(first);
  // pretend the uploader made the first one, and one more that is gone from the list
  const gone = id(999);
  last.set(gone, { pnl: -120, at: '2026-10-19T09:50:00Z' });
  const owned = quantiplyOwned([
    { action: 'create', ok: true, id: first, name: 'Core · N_p100_1202' },
    { action: 'create', ok: true, id: gone, name: 'Core · N_wide_1117' },
    { action: 'create', ok: false, id: id(998), name: 'Core · x' },
  ]);
  const lines = quantiplyLines('2026-10-19', 'angelone', summaries, last, owned);
  assert.equal(lines.length, 7);
  const mine = lines.filter((l) => l.source === 'tool');
  // the list's name is shown (the owner may rename); the variant comes from a tool name only
  assert.deepEqual(
    mine.map((l) => [l.platform_id, l.multiplier]).sort(),
    [
      [first, 1],
      [gone, null],
    ].sort(),
  );
  assert.equal(lines.find((l) => l.platform_id === gone)?.variant, 'N_wide_1117');
  assert.ok(lines.filter((l) => l.source === 'discretionary').every((l) => l.variant === null));
  assert.ok(lines.every((l) => l.pnl_source === 'pnl-chart'));
});

test('Quantiply: fills only from a state whose fields are plain, else null', () => {
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
        entry: { price: 100, at: '' },
        exit: { price: 80, at: '' },
      },
    ],
  );
  assert.equal(quantiplyFills({ data: { state: { positions: [{ side: 'CE' }] } } }), null);
});

const sectionLine = (
  platform: 'algotest' | 'quantiply',
  broker: string,
  ok: boolean,
): SectionLine => ({
  kind: 'section',
  day: '2026-10-21',
  platform,
  broker: broker as SectionLine['broker'],
  ok,
  error: ok ? null : 'login failed',
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
  assert.ok(captureCovers(merged, 'quantiply', 'angelone')); // the earlier good read stands
  // with nothing earlier, a failed section is recorded as failed
  const fresh = mergeCapture(
    [],
    [{ section: sectionLine('quantiply', 'angelone', false), strategies: [] }],
  );
  assert.equal(captureCovers(fresh, 'quantiply', 'angelone'), false);
  assert.equal(captureCovers(fresh, 'algotest'), false);
  // the file round-trips, a torn line is skipped
  const text = `${renderLiveFile(merged)}{"kind":"strat`;
  assert.deepEqual(parseLiveFile(text), merged);
});
