import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLive } from './deploy-plan.js';
import {
  LOSS_ALERT_INR,
  LOSS_WARNING_INR,
  type QListed,
  algotestInstant,
  checkAlgoTest,
  checkQuantiply,
  deployMessage,
  inLossWindow,
  inr,
  istDayOf,
  legLots,
  legsFromAlgtst,
  legsFromQuantiply,
  lossCrossings,
  lossMessage,
  marginMessage,
  marginVerdict,
  parseAlgotestBrokers,
  parseDayWiseListed,
  parseMarginCsv,
  parseRupees,
  parseTotalMtm,
  pickNeed,
  pnlFromSocketFrame,
  quantiplyMtm,
  switchOn,
  unreadActive,
} from './monitor-plan.js';

// /live's header as read on 2026-10-20 15:13 IST (trimmed): no broker logged in, nothing deployed.
const HEADER = `Algo Trade
Auto Activation
Broker Login 0/2
0/6 Strategy Deployed
Total MTM

₹ 0

Today's

MTM Graph

Open Positions
0
`;

const row = (name: string, deployed: number) =>
  `${name}\n\nNIFTY\n\n•\nINTRADAY\n\nReady to deploy\n\n${deployed} Deployed\n\n-\n-\n-\n-\n-\n-\n-\n\n`;

const live = (brokers: string, rows: string) =>
  parseLive(
    `Broker Login ${brokers}\n2/6 Strategy Deployed\nTotal MTM\n₹ -1,234\n\nActivation\n\n${rows}`,
  );

test('switches are on only when exactly "on"', () => {
  assert.equal(switchOn({ LOSS_ALERTS: ' On ' }, 'LOSS_ALERTS'), true);
  assert.equal(switchOn({ LOSS_ALERTS: 'yes' }, 'LOSS_ALERTS'), false);
  assert.equal(switchOn({}, 'LOSS_ALERTS'), false);
});

test('rupee figures: signs either side of ₹, Indian grouping, none', () => {
  assert.equal(parseRupees('₹ 0'), 0);
  assert.equal(parseRupees('₹ -1,23,456.50'), -123456.5);
  assert.equal(parseRupees('-₹ 5,234'), -5234);
  assert.equal(parseRupees('− ₹12'), -12);
  assert.equal(parseRupees('no money here'), null);
  assert.equal(inr(-5234.4), '₹-5,234');
  assert.equal(inr(1250073.78), '₹12,50,074');
});

test('the Total MTM figure is read off the /live header', () => {
  assert.equal(parseTotalMtm(HEADER), 0);
  assert.equal(parseTotalMtm(HEADER.replace('₹ 0', '₹ -6,512.25')), -6512.25);
  assert.equal(parseTotalMtm('Algo Trade\nBroker Login 1/2'), null);
});

test("AlgoTest's broker funds: available, the UTC stamps, deleted brokers left out", () => {
  const brokers = parseAlgotestBrokers({
    brokers: [
      {
        broker: 'Broker.Finvasia',
        deleted: false,
        logged_until: '2026-10-19T10:10:00.000',
        margin: { available: 1250073.78, updated_ts: '2026-10-19T02:47:39.300' },
        app_keys: { ApiKey: 'never-read' },
      },
      { broker: 'Broker.Old', deleted: true, margin: { available: 1 } },
      { broker: 'Broker.AngelOne', margin: {} },
    ],
  });
  assert.deepEqual(
    brokers.map((b) => [b.broker, b.available]),
    [
      ['Broker.Finvasia', 1250073.78],
      ['Broker.AngelOne', null],
    ],
  );
  assert.ok(!JSON.stringify(brokers).includes('never-read'));
  const at = algotestInstant(brokers[0]?.updatedAt ?? null);
  assert.equal(at?.toISOString(), '2026-10-19T02:47:39.300Z');
  assert.equal(istDayOf(at as Date), '2026-10-19'); // 08:17 IST
  assert.throws(() => parseAlgotestBrokers({}), /no brokers list/);
});

test('margin need: half the straddle per sold leg-lot, NIFTY borrowed, an allowance per bought lot', () => {
  const per = parseMarginCsv(
    'underlying,strategy_type,month,margin_inr\nNIFTY,short-straddle,2026-07,120000\nNIFTY,short-straddle,2026-08,140000\n',
  );
  assert.equal(per.get('NIFTY'), 140000);
  const algtst = {
    strategy: {
      Ticker: 'SENSEX',
      ListOfLegConfigs: [
        { PositionType: 'PositionType.Sell', LotConfig: { Value: 1 } },
        { PositionType: 'PositionType.Sell', LotConfig: { Value: 2 } },
      ],
    },
  };
  const legs = legsFromAlgtst(algtst);
  assert.deepEqual(legs, [
    { underlying: 'SENSEX', sell: true, lots: 1 },
    { underlying: 'SENSEX', sell: true, lots: 2 },
  ]);
  assert.deepEqual(pickNeed('x', legs, per), { name: 'x', inr: 210000, borrowed: ['SENSEX'] });
  const buy = legsFromQuantiply({
    configurations: { legs: [{ base: 'NIFTY', transactionType: 'B', quantity: 2 }] },
  });
  assert.equal(pickNeed('b', buy, per).inr, 10000);
});

test('margin verdict and message: a 20% cushion, short, unknown', () => {
  assert.equal(marginVerdict(130, 100), 'ok');
  assert.equal(marginVerdict(110, 100), 'tight');
  assert.equal(marginVerdict(90, 100), 'short');
  assert.equal(marginVerdict(null, 100), 'unknown');
  const m = marginMessage('2026-10-21', [
    {
      account: 'Finvasia',
      uses: ['AlgoTest T1 preview'],
      picks: [{ name: 'a', inr: 140000, borrowed: ['SENSEX'] }],
      free: 100000,
      source: 'from AlgoTest',
    },
    {
      account: 'Angel One',
      uses: ['Quantiply Core'],
      picks: [],
      free: 500000,
      source: 's',
      picksMissing: true,
    },
  ]);
  assert.equal(m.ok, false);
  assert.match(m.text, /❌ Finvasia .*SHORT by ₹40,000/);
  assert.match(m.text, /SENSEX estimated with NIFTY/);
  assert.match(m.text, /❔ Angel One .*need not known/);
});

test('AlgoTest deploy check: once, multiplier 1, missing, twice, extra, the owner’s own', () => {
  const state = live(
    '1/2',
    row('T1 · A', 1) +
      row('T1 · B', 0) +
      row('T1 · C', 2) +
      row('T1 · X', 1) +
      row('Mine', 1) +
      row('T1 · D', 1),
  );
  const c = checkAlgoTest(
    'AlgoTest T1',
    ['T1 · A', 'T1 · B', 'T1 · C', 'T1 · D', 'T1 · E'],
    state,
    new Map([['T1 · D', 2]]),
  );
  assert.deepEqual(c.good, ['T1 · A']);
  assert.deepEqual(c.problems, [
    'T1 · B: not deployed',
    'T1 · C: deployed 2 times',
    'T1 · D: multiplier 2, not 1',
    'T1 · E: not in AlgoTest',
  ]);
  assert.deepEqual(c.extra, ['T1 · X (1 Deployed)']);
  assert.deepEqual(c.notes, ["also deployed (not the tool's): Mine"]);
  const none = checkAlgoTest('AlgoTest T1', [], live('0/2', ''), new Map());
  assert.match(none.problems[0] ?? '', /no broker logged in/);
});

const q = (name: string, day: string, enabled: boolean, extra: Partial<QListed> = {}): QListed => ({
  id: `${name}-${day}`,
  name,
  day,
  enabled,
  status: 'NOT_RUNNING',
  multiplier: 1,
  ...extra,
});

test('Quantiply deploy check: enabled once on the weekday at 1x with the export lots', () => {
  const algos = [
    q('Core · A', 'WED', true),
    q('Core · B', 'WED', false),
    q('Core · C', 'WED', true, { multiplier: 2 }),
    q('Core · D', 'WED', true),
    q('Core · E', 'TUE', true),
    q('Core · X', 'WED', true),
    q('N_ITM1_SL21_3000', 'WED', true),
  ];
  const c = checkQuantiply(
    'Quantiply Core',
    [
      { name: 'Core · A', lots: [1, 1] },
      { name: 'Core · B', lots: [1, 1] },
      { name: 'Core · C', lots: [1, 1] },
      { name: 'Core · D', lots: [1, 1] },
      { name: 'Core · E', lots: [1, 1] },
    ],
    algos,
    'WED',
    new Map([
      ['Core · A-WED', [1, 1]],
      ['Core · D-WED', [2, 2]],
    ]),
  );
  assert.deepEqual(c.good, ['Core · A']);
  assert.deepEqual(c.problems, [
    'Core · B: not enabled',
    'Core · C: multiplier 2, not 1',
    'Core · D: lots 2/2, the export says 1/1',
    'Core · E: not in Quantiply for WED',
  ]);
  assert.deepEqual(c.extra, ['Core · X (enabled)']);
  assert.deepEqual(c.notes, ["also enabled for WED (not the tool's): N_ITM1_SL21_3000"]);
});

test('the deploy message: one headline, then what is wrong', () => {
  const ok = deployMessage('2026-10-21', [
    {
      label: 'AlgoTest T1',
      expected: 3,
      good: ['a', 'b', 'c'],
      problems: [],
      extra: [],
      notes: [],
    },
    {
      label: 'Quantiply Core',
      expected: 3,
      good: ['a', 'b', 'c'],
      problems: [],
      extra: [],
      notes: [],
    },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.text.split('\n')[0], 'AlgoTest T1 3/3 · Quantiply Core 3/3 ✅');
  const bad = deployMessage('2026-10-21', [
    {
      label: 'AlgoTest T1',
      expected: 3,
      good: ['a'],
      problems: ['b: not deployed'],
      extra: ['x'],
      notes: [],
    },
    {
      label: 'Quantiply Core',
      expected: 0,
      good: [],
      problems: [],
      extra: [],
      notes: [],
      error: 'login held',
    },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.text.split('\n')[0], 'AlgoTest T1 1/3 · Quantiply Core not read ⚠️');
  assert.match(bad.text, /❌ AlgoTest T1: b: not deployed/);
  assert.match(bad.text, /➕ AlgoTest T1 extra: x/);
  assert.match(bad.text, /❌ Quantiply Core: login held/);
});

test('loss levels: each once a day; straight past the alert sends the alert alone', () => {
  assert.deepEqual(lossCrossings(-4999, { warned: false, alerted: false }), []);
  assert.deepEqual(lossCrossings(LOSS_WARNING_INR, { warned: false, alerted: false }), ['warning']);
  assert.deepEqual(lossCrossings(-6000, { warned: true, alerted: false }), []);
  assert.deepEqual(lossCrossings(LOSS_ALERT_INR, { warned: true, alerted: false }), ['alert']);
  assert.deepEqual(lossCrossings(-9000, { warned: false, alerted: false }), ['alert']);
  assert.deepEqual(lossCrossings(-9000, { warned: true, alerted: true }), []);
  const text = lossMessage(
    'alert',
    -8100,
    [
      { label: 'AlgoTest', inr: -5000 },
      { label: 'Quantiply Angel One', inr: null },
    ],
    '11:42',
  );
  assert.match(text, /LOSS ALERT 11:42: the day is at ₹-8,100/);
  assert.match(text, /Quantiply Angel One: not readable/);
  assert.match(text, /nothing was squared off/);
});

test("Quantiply's socket frames: the CSV algo update in a socket.io packet", () => {
  const id = '6ad597a2892783f88a7e4ce5';
  assert.deepEqual(pnlFromSocketFrame(`42["message","${id},,,,-1520.5,false:0:0,,false,false"]`), [
    { id, pnl: -1520.5 },
  ]);
  assert.deepEqual(pnlFromSocketFrame(`42["message",{"data":"${id},a,b,c,310"}]`), [
    { id, pnl: 310 },
  ]);
  assert.deepEqual(pnlFromSocketFrame('3'), []);
  assert.deepEqual(pnlFromSocketFrame('42["message","NIFTY,NSE,1729,25010.5"]'), []);
  assert.deepEqual(pnlFromSocketFrame(`42["message","${id},,,,"]`), []);
});

test("Quantiply's MTM: today's weekday only; an active algo with no figure is unread", () => {
  const algos = [
    q('Core · A', 'WED', true, { id: 'a', status: 'TRADE_ACTIVE' }),
    q('Core · B', 'WED', true, { id: 'b', status: 'TRADE_CLOSED' }),
    q('Core · C', 'WED', true, { id: 'c', status: 'TRADE_ACTIVE' }),
    q('Core · D', 'TUE', true, { id: 'd' }),
  ];
  const pnl = { a: -1000, b: 250, d: -99999 };
  assert.equal(quantiplyMtm(algos, 'WED', pnl), -750);
  assert.deepEqual(unreadActive(algos, 'WED', pnl), ['Core · C']);
});

test('the day-wise list keeps the multiplier; leg lots of an algo', () => {
  const listed = parseDayWiseListed({
    data: [
      {
        day: 'WED',
        algos: [
          {
            _id: 'x',
            name: 'Core · A',
            day: 'WED',
            enabled: true,
            status: 'NOT_RUNNING',
            multiplier: 1,
          },
        ],
      },
      { day: 'THU', algos: [] },
    ],
  });
  assert.deepEqual(listed, [
    { id: 'x', name: 'Core · A', day: 'WED', enabled: true, status: 'NOT_RUNNING', multiplier: 1 },
  ]);
  assert.deepEqual(
    legLots({ configurations: { legs: [{ quantity: 1 }, { quantity: 2 }] } }),
    [1, 2],
  );
});

test('the loss window is 09:15 to 15:30 IST', () => {
  assert.equal(inLossWindow(9 * 60 + 14), false);
  assert.equal(inLossWindow(9 * 60 + 15), true);
  assert.equal(inLossWindow(15 * 60 + 29), true);
  assert.equal(inLossWindow(15 * 60 + 30), false);
});
