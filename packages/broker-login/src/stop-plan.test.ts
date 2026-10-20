import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { QAlgo, QLedgerRow } from './quantiply-plan.js';
import {
  appendStopLog,
  clearHold,
  holdPath,
  readHold,
  stopHeld,
  stopLogPath,
  writeHold,
} from './stop-hold.js';
import {
  A_LIVE,
  A_SQUARED_OFF,
  A_STOPPED,
  algotestAfter,
  canSquareOff,
  parseExecutions,
  planAlgoTestStop,
  planQuantiplyStop,
  quantiplyLeft,
} from './stop-plan.js';
import { istToday } from './strategy-plan.js';

const row = (id: string, name: string, action: 'create' | 'delete' = 'create'): QLedgerRow => ({
  at: '2026-10-19T11:55:27Z',
  day: '2026-10-20',
  weekday: 'TUE',
  mode: 'evening',
  action,
  id,
  name,
  sha: 'a',
  ok: true,
});
const algo = (id: string, name: string, status: string, enabled = true, day = 'TUE'): QAlgo => ({
  id,
  name,
  day,
  enabled,
  status,
});

test('Quantiply: only the tool algos; open ones squared off, enabled ones switched off', () => {
  const ledger = [
    row('a', 'Core · A'),
    row('b', 'Core · B'),
    row('c', 'Core · C'),
    row('d', 'Core · D'),
    row('e', 'Core · E'),
    row('gone', 'Core · Gone'),
    row('gone', 'Core · Gone', 'delete'),
  ];
  const p = planQuantiplyStop(ledger, [
    algo('a', 'Core · A', 'TRADE_ACTIVE'),
    algo('b', 'Core · B', 'READY'),
    algo('c', 'Core · C', 'NOT_RUNNING', true, 'WED'), // tomorrow's, enabled: switched off too
    algo('d', 'Core · D', 'TRADE_CLOSED', false),
    algo('e', 'Core · E', 'SOMETHING_NEW'),
    algo('gone', 'Core · Gone', 'TRADE_ACTIVE'), // deleted from the ledger: not the tool's
    algo('mine', 'my own', 'TRADE_ACTIVE'),
    algo('mine2', 'my own off', 'NOT_RUNNING', false),
  ]);
  assert.deepEqual(
    p.sqOff.map((a) => a.id),
    ['a'],
  );
  assert.deepEqual(
    p.disable.map((a) => a.id),
    ['b', 'c'],
  );
  assert.deepEqual(
    p.byHand.map((a) => a.id),
    ['e'],
  );
  assert.deepEqual(
    p.notMine.map((a) => a.id),
    ['gone', 'mine'],
  );
  assert.equal(p.idle, 1);
});

test('Quantiply: what is left after the calls is named for the owner', () => {
  const ledger = [
    row('a', 'Core · A'),
    row('b', 'Core · B'),
    row('c', 'Core · C'),
    row('d', 'Core · D'),
  ];
  const left = quantiplyLeft(ledger, [
    algo('a', 'Core · A', 'TRADE_ACTIVE', false),
    algo('b', 'Core · B', 'NOT_RUNNING', true),
    algo('c', 'Core · C', 'TRADE_CLOSED', false),
    algo('d', 'Core · D', 'READY', false),
    algo('x', 'mine', 'TRADE_ACTIVE'),
  ]);
  assert.equal(left.length, 3);
  assert.match(left[2] ?? '', /Core · D .*still READY: check it does not enter/);
  assert.match(left[0] ?? '', /Core · A .*square off by hand/);
  assert.match(left[1] ?? '', /Core · B .*switch off by hand/);
});

const exec = (id: string, name: string, status: string, active = true) => ({
  _id: id,
  name,
  status,
  active_on_server: active,
});

test('AlgoTest: parse the live list (an array, or {data})', () => {
  const list = [exec('6ad590af06a3aebabc43634d', 'T1 · X', A_LIVE)];
  assert.equal(parseExecutions(list)[0]?.activeOnServer, true);
  assert.equal(parseExecutions({ data: list })[0]?.name, 'T1 · X');
  assert.throws(() => parseExecutions({}), /not an array/);
  assert.throws(() => parseExecutions([{ name: 'x' }]), /without _id/);
});

test("AlgoTest: square off the tool's live deploys only, by the web app's own rule", () => {
  const execs = parseExecutions([
    exec('1', 'T1 · Live', A_LIVE),
    exec('2', 'Core · Error', 'StrategyStatus.Error'),
    exec('3', 'T1 · NotOnServer', A_LIVE, false),
    exec('4', 'T1 · Paused', 'paused'),
    exec('5', 'T1 · Done', A_SQUARED_OFF),
    exec('6', 'my own', A_LIVE),
    exec('7', 'my own done', A_STOPPED),
  ]);
  assert.equal(canSquareOff(execs[2] as never), false);
  const p = planAlgoTestStop(execs);
  assert.deepEqual(
    p.squareOff.map((e) => e.id),
    ['1', '2'],
  );
  assert.deepEqual(
    p.byHand.map((e) => e.id),
    ['3', '4'],
  );
  assert.deepEqual(
    p.notMine.map((e) => e.id),
    ['6'],
  );
  assert.equal(p.done, 1);
});

test('AlgoTest: only squared off counts as confirmed; stopped means positions may be open', () => {
  const targets = parseExecutions([
    exec('1', 'T1 · A', A_LIVE),
    exec('2', 'T1 · B', A_LIVE),
    exec('3', 'T1 · C', A_LIVE),
    exec('4', 'T1 · D', A_LIVE),
  ]);
  const r = algotestAfter(
    targets,
    parseExecutions([
      exec('1', 'T1 · A', A_SQUARED_OFF),
      exec('2', 'T1 · B', A_STOPPED),
      exec('3', 'T1 · C', A_LIVE),
    ]),
  );
  assert.deepEqual(r.confirmed, ['T1 · A']);
  assert.equal(r.pending.length, 1);
  assert.equal(r.byHand.length, 2);
  assert.match(r.byHand[0] ?? '', /STOPPED.*square off by hand/);
  assert.match(r.byHand[1] ?? '', /no longer listed/);
});

test('hold: written for today, read back, found by the deployers, cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stop-hold-'));
  try {
    const today = istToday();
    assert.equal(readHold(root, today), null);
    assert.equal(stopHeld({ TRADING_DATA_ROOT: root }), null);
    const path = await writeHold(root, 'test');
    assert.equal(path, holdPath(root, today));
    assert.equal(path, join(root, 'stop', `hold-${today}.json`)); // the scheduler reads this path
    assert.equal(readHold(root, today)?.by, 'test');
    assert.match(stopHeld({ TRADING_DATA_ROOT: root }) ?? '', /held by the stop button/);
    // tomorrow is not held
    const tomorrow = new Date(Date.now() + 86_400_000);
    assert.equal(stopHeld({ TRADING_DATA_ROOT: root }, tomorrow), null);
    assert.equal(stopHeld({}), null);
    assert.equal(await clearHold(root, today), true);
    assert.equal(readHold(root, today), null);
    assert.equal(await clearHold(root, today), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stop log: one JSON line per step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stop-log-'));
  try {
    await appendStopLog(root, { who: 'runner', step: 'a' });
    await appendStopLog(root, { who: 'runner', step: 'b' });
    const lines = (await readFile(stopLogPath(root, istToday()), 'utf8')).trim().split('\n');
    assert.deepEqual(
      lines.map((l) => (JSON.parse(l) as { step: string }).step),
      ['a', 'b'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
