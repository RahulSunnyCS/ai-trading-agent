import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type LiveState,
  brokerRefusal,
  cardShows,
  checkBrokerSheet,
  istMinutes,
  minutesOf,
  nothingOnAlgotest,
  parseCards,
  parseLive,
  planDeploy,
  planSetup,
  repeating,
  secondsUntil,
  stillDeployed,
} from './deploy-plan.js';

// /live's innerText on 2026-10-19 09:18 IST (trimmed), one strategy deployed by hand.
const PAGE = `Algo Trade
Auto Activation
History
Broker Login 1/2
Auto restart paused executions
0/6 Strategy Deployed
Deployed Strategies
Switch all to manual
Square off all

Deployed on 19 OCT 26

Intraday

T1 · N_p150-t1s11_091...

NIFTY
•
Open Pos: 2
RUNNING
₹ 81.25
Finvasia - Shiny

Activation

Strategies
Portfolios
RA Algos
CryptoBazaar Algos

Filter

Nifty_Widesl_917_OTM1

NIFTY

•
INTRADAY

Setup Pending

0 Deployed

-
-
-
-
-
-
-

Setup Execution
Activate
T1 · N_p150-t1s11_0917

NIFTY

•
INTRADAY

Ready to deploy

1 Deployed

-
-
-
-
-
-
-

Edit Execution
Activate
T1 · N_ditm1-t1s36_0947

NIFTY

•
INTRADAY

Setup Pending

0 Deployed

-
-
-
-
-
-
-

Setup Execution
Activate
T1 · N_p150-t1s11_1317

NIFTY

•
INTRADAY

Setup Pending

0 Deployed

M
-
-
-
-
-
-

Setup Execution
Activate`;

test('parseLive reads the counts and every Activation row', () => {
  const live = parseLive(PAGE);
  assert.equal(live.brokersLoggedIn, 1);
  assert.equal(live.brokersTotal, 2);
  assert.equal(live.slotsUsed, 0);
  assert.equal(live.slotsMax, 6);
  assert.deepEqual(
    live.rows.map((r) => [r.name, r.status, r.deployed]),
    [
      ['Nifty_Widesl_917_OTM1', 'Setup Pending', 0],
      ['T1 · N_p150-t1s11_0917', 'Ready to deploy', 1],
      ['T1 · N_ditm1-t1s36_0947', 'Setup Pending', 0],
      ['T1 · N_p150-t1s11_1317', 'Setup Pending', 0],
    ],
  );
  assert.deepEqual(live.rows[0]?.days, ['-', '-', '-', '-', '-', '-', '-']);
});

const picks = [
  { name: 'T1 · N_p150-t1s11_1317', entry: minutesOf('13:17') },
  { name: 'T1 · N_p150-t1s11_0917', entry: minutesOf('09:17') },
  { name: 'T1 · N_ditm1-t1s36_0947', entry: minutesOf('09:47') },
];

test('deploys only what is not yet deployed and not yet due, in entry order', () => {
  const p = planDeploy(picks, parseLive(PAGE), minutesOf('09:20'));
  assert.equal(p.refused, null);
  assert.deepEqual(
    p.deploy.map((d) => d.name),
    ['T1 · N_ditm1-t1s36_0947', 'T1 · N_p150-t1s11_1317'],
  );
  assert.deepEqual(p.already, ['T1 · N_p150-t1s11_0917']);
});

test('a pick whose entry minute has come is too late, never deployed late', () => {
  const live = parseLive(
    PAGE.replace('Ready to deploy\n\n1 Deployed', 'Setup Pending\n\n0 Deployed'),
  );
  const p = planDeploy(picks, live, minutesOf('09:17'));
  assert.deepEqual(p.tooLate, ['T1 · N_p150-t1s11_0917']);
  assert.ok(!p.deploy.some((d) => d.name === 'T1 · N_p150-t1s11_0917'));
});

test('refuses outside 08:00-15:40 and with no broker logged in', () => {
  assert.match(planDeploy(picks, parseLive(PAGE), minutesOf('07:59')).refused ?? '', /outside/);
  assert.match(planDeploy(picks, parseLive(PAGE), minutesOf('15:40')).refused ?? '', /outside/);
  const none = parseLive(PAGE.replace('Broker Login 1/2', 'Broker Login 0/2'));
  const p = planDeploy(picks, none, minutesOf('09:20'));
  assert.match(p.refused ?? '', /no broker/);
  assert.deepEqual(p.deploy, []);
});

test('the strategy limit caps the deploys, earliest entries first', () => {
  const live: LiveState = { ...parseLive(PAGE), slotsUsed: 5, slotsMax: 6 };
  const p = planDeploy(picks, live, minutesOf('09:20'));
  assert.deepEqual(
    p.deploy.map((d) => d.name),
    ['T1 · N_ditm1-t1s36_0947'],
  );
  assert.deepEqual(p.noSlot, ['T1 · N_p150-t1s11_1317']);
});

test('a pick missing from AlgoTest or without the tool prefix is never deployed', () => {
  const p = planDeploy(
    [
      { name: 'T1 · N_wide_1117', entry: minutesOf('11:17') },
      { name: 'Nifty_Widesl_917_OTM1', entry: minutesOf('11:37') },
    ],
    parseLive(PAGE),
    minutesOf('09:20'),
  );
  assert.deepEqual(p.deploy, []);
  assert.deepEqual(p.missing, ['T1 · N_wide_1117', 'Nifty_Widesl_917_OTM1']);
});

test('repeating lists tool strategies with a ticked day', () => {
  assert.deepEqual(repeating(parseLive(PAGE)), ['T1 · N_p150-t1s11_1317']);
});

test('istMinutes is IST whatever the host zone', () => {
  assert.equal(istMinutes(new Date('2026-10-19T03:46:00Z')), minutesOf('09:16'));
});

test('parseLive reads rows that have no ticker line (as /live showed at night)', () => {
  const night = PAGE.replace(/\nNIFTY\n\n•\nINTRADAY/g, '\n\n•\nINTRADAY');
  assert.deepEqual(
    parseLive(night).rows.map((r) => r.name),
    parseLive(PAGE).rows.map((r) => r.name),
  );
});

// The Deployed Strategies section at 10:09 IST (trimmed): two copies of one strategy, one
// squared off, and a cut name shared by two strategies.
const CARDS = `Deployed Strategies
Switch all to manual

Deployed on 19 OCT 26

Intraday

T1 · N_p150-t1s11_091...

NIFTY
•
Open Pos: 1
RUNNING
₹ -1,426.75
Finvasia - Shiny
Intraday

T1 · N_ditm1-t1s36_09...

NIFTY
•
Open Pos: 1
RUNNING
₹ 939.25
Intraday

T1 · N_p150-t1s11_131...

NIFTY
•
Open Pos: 0
SQD OFF
₹ -4,095

Activation
`;

test('parseCards reads each card and its state', () => {
  assert.deepEqual(parseCards(CARDS), [
    { name: 'T1 · N_p150-t1s11_091...', state: 'RUNNING' },
    { name: 'T1 · N_ditm1-t1s36_09...', state: 'RUNNING' },
    { name: 'T1 · N_p150-t1s11_131...', state: 'SQD OFF' },
  ]);
});

test('cardShows matches a cut name by its start only', () => {
  const card = { name: 'T1 · N_ditm1-t1s36_09...', state: 'RUNNING' };
  assert.equal(cardShows(card, 'T1 · N_ditm1-t1s36_0947'), true);
  assert.equal(cardShows(card, 'T1 · N_ditm1-t1s36_0932'), true);
  assert.equal(cardShows(card, 'T1 · N_ditm1-t1s36_1047'), false);
});

test('stillDeployed: a squared-off instance does not count, a running one does', () => {
  const live = parseLive(
    PAGE.replace(
      'T1 · N_p150-t1s11_1317\n\nNIFTY\n\n•\nINTRADAY\n\nSetup Pending\n\n0 Deployed',
      'T1 · N_p150-t1s11_1317\n\nNIFTY\n\n•\nINTRADAY\n\nReady to deploy\n\n1 Deployed',
    ),
  );
  const cards = parseCards(CARDS);
  assert.equal(stillDeployed('T1 · N_p150-t1s11_1317', live, cards), false);
  assert.equal(stillDeployed('T1 · N_p150-t1s11_0917', live, cards), true);
  assert.equal(stillDeployed('T1 · N_ditm1-t1s36_0947', live, cards), false); // 0 Deployed
  assert.equal(stillDeployed('T1 · not on the page', live, cards), true);
});

test('secondsUntil counts to the start of the entry minute in IST', () => {
  // 09:16:40 IST = 03:46:40 UTC
  assert.equal(secondsUntil(minutesOf('09:17'), new Date('2026-10-19T03:46:40Z')), 20);
  assert.ok(secondsUntil(minutesOf('09:17'), new Date('2026-10-19T03:47:05Z')) < 0);
});

test('nothingOnAlgotest: a deploy needs an AlgoTest row that uploads the book', () => {
  assert.equal(nothingOnAlgotest(['t1'], 't1', false, [], '2026-10-27'), null);
  assert.match(
    nothingOnAlgotest([], 't1', false, ['2026-10-27'], '2026-10-27') ?? '',
    /uploads the T1 list: nothing to deploy/,
  );
  assert.match(nothingOnAlgotest(['core'], 't1', false, [], '2026-10-27') ?? '', /T1/);
});

test('nothingOnAlgotest: the 15:35 check still runs after a deploy today', () => {
  assert.equal(nothingOnAlgotest(['t1'], 't1', true, [], '2026-10-27'), null);
  assert.equal(nothingOnAlgotest([], 't1', true, ['2026-10-27'], '2026-10-27'), null);
  assert.match(
    nothingOnAlgotest([], 't1', true, ['2026-10-26'], '2026-10-27') ?? '',
    /deployed nothing today: nothing to check/,
  );
});

// /live's innerText on 2026-11-02 19:40 IST (trimmed): no "n/6 Strategy Deployed" any more, the
// three evening uploads not yet set up.
const PAGE_NOV = `Algo Trade
Auto Activation
History
Broker Login 0/2
Auto restart paused executions
Total MTM
Deployed Strategies

Show archived

Running
Paused
Sq Off
Error
Manual

No strategies found

Activation

Strategies
Portfolios
RA Algos
CryptoBazaar Algos

Filter

T1 · N_p80_0947

NIFTY

•
INTRADAY

Setup Pending

0 Deployed

-
-
-
-
-
-
-

Setup Execution
Activate
T1 · N_p80_0932

NIFTY

•
INTRADAY

Setup Pending

0 Deployed

-
-
-
-
-
-
-

Setup Execution
Activate
T1 · N_wide_0947

NIFTY

•
INTRADAY

Setup Pending

0 Deployed

-
-
-
-
-
-
-

Setup Execution
Activate`;

const novPicks = [
  { name: 'T1 · N_p80_0947', entry: minutesOf('09:47') },
  { name: 'T1 · N_p80_0932', entry: minutesOf('09:32') },
  { name: 'T1 · N_wide_0947', entry: minutesOf('09:47') },
];

test('parseLive reads a page without the strategy count as no limit', () => {
  const live = parseLive(PAGE_NOV);
  assert.equal(live.slotsMax, null);
  assert.equal(live.brokersTotal, 2);
  assert.deepEqual(
    live.rows.map((r) => [r.name, r.status, r.deployed]),
    novPicks.map((p) => [p.name, 'Setup Pending', 0]),
  );
});

test('with no strategy count shown, every due pick is deployed (no slot limit invented)', () => {
  const live = parseLive(PAGE_NOV.replace('Broker Login 0/2', 'Broker Login 2/2'));
  const p = planDeploy(novPicks, live, minutesOf('08:20'));
  assert.equal(p.refused, null);
  assert.deepEqual(
    p.deploy.map((d) => d.name),
    ['T1 · N_p80_0932', 'T1 · N_p80_0947', 'T1 · N_wide_0947'],
  );
  assert.deepEqual(p.noSlot, []);
});

test('planSetup sets up every uploaded pick in entry order, never a deployed one', () => {
  const live = parseLive(PAGE_NOV.replace(/(T1 · N_wide_0947[\s\S]*?)0 Deployed/, '$11 Deployed'));
  const p = planSetup([...novPicks, { name: 'T1 · N_dir_1017', entry: minutesOf('10:17') }], live);
  assert.deepEqual(
    p.setup.map((d) => d.name),
    ['T1 · N_p80_0932', 'T1 · N_p80_0947'],
  );
  assert.deepEqual(p.deployed, ['T1 · N_wide_0947']);
  assert.deepEqual(p.missing, ['T1 · N_dir_1017']);
  // the night page has no broker logged in: setting up does not need one
  assert.equal(live.brokersLoggedIn, 0);
});

// The broker sheet "Activate" opened on 2026-11-03 (innerText, the owner's session).
const BROKER_SHEET = `Select Broker for T1 · N_p80_0947

Edit Entry/Exit Timings
0 / 2 selected
Angel One - Rahul
LOGGED IN
Finvasia - Shiny
LOGGED IN
Cancel
Activate`;

test('broker sheet: every wanted broker listed and logged in (BL-197)', () => {
  assert.deepEqual(checkBrokerSheet(BROKER_SHEET, ['finvasia', 'angelone']), {
    missing: [],
    notLoggedIn: [],
  });
  assert.deepEqual(checkBrokerSheet(BROKER_SHEET, ['finvasia']), { missing: [], notLoggedIn: [] });
  const out = BROKER_SHEET.replace('Finvasia - Shiny\nLOGGED IN', 'Finvasia - Shiny\nLOGIN');
  assert.deepEqual(checkBrokerSheet(out, ['finvasia', 'angelone']), {
    missing: [],
    notLoggedIn: ['Finvasia'],
  });
  const gone = BROKER_SHEET.replace('Angel One - Rahul\nLOGGED IN\n', '');
  assert.deepEqual(checkBrokerSheet(gone, ['angelone']), {
    missing: ['Angel One'],
    notLoggedIn: [],
  });
});

// 2026-11-03 09:16: both brokers logged in at 08:17, yet the deployer read no "Broker Login n/m"
// and refused as "0/0". A count the page did not show is unread, never "logged out".
test('the broker count is read when split over lines or spaced', () => {
  for (const shown of ['Broker Login\n2/2', 'Broker Login 2 / 2', 'Broker Login2/2']) {
    const live = parseLive(PAGE_NOV.replace('Broker Login 0/2', shown));
    assert.equal(live.brokersLoggedIn, 2, shown);
    assert.equal(live.brokersTotal, 2, shown);
  }
});

test('a broker count missing from /live is unread: the deploy refuses as such, not as logged out', () => {
  const live = parseLive(PAGE_NOV.replace('Broker Login 0/2\n', ''));
  assert.equal(live.brokersLoggedIn, null);
  assert.equal(live.brokersTotal, null);
  const p = planDeploy(novPicks, live, minutesOf('09:16'));
  assert.match(p.refused ?? '', /could not read the broker count/);
  assert.doesNotMatch(p.refused ?? '', /0\/0|no broker logged in/);
  assert.deepEqual(p.deploy, []);
  assert.equal(
    brokerRefusal(parseLive(PAGE_NOV)),
    'no broker logged in on AlgoTest (Broker Login 0/2)',
  );
  assert.equal(
    brokerRefusal(parseLive(PAGE_NOV.replace('Broker Login 0/2', 'Broker Login 2/2'))),
    null,
  );
});
