import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type LiveState,
  istMinutes,
  minutesOf,
  parseLive,
  planDeploy,
  repeating,
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
