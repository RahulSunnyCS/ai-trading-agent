import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { QAlgo, QLedgerRow } from './quantiply-plan.js';
import {
  appendStopLog,
  clearHold,
  holdPath,
  markStopRunning,
  otherStopRunning,
  readHold,
  stateHoldPath,
  stopHeld,
  stopLogPath,
  stopRunningPaths,
  writeHold,
} from './stop-hold.js';
import {
  A_LIVE,
  A_SQUARED_OFF,
  A_STOPPED,
  type Watched,
  algotestOutcome,
  canSquareOff,
  capped,
  parseExecutions,
  planAlgoTestStop,
  planQuantiplyStop,
  quantiplyLeft,
  squaringOff,
  stopSessions,
  toolMatcher,
} from './stop-plan.js';
import { type LedgerRow, istToday } from './strategy-plan.js';

// never the real scheduler state dir (the hold's second copy lives there)
process.env.SCHEDULER_STATE_DIR = join(tmpdir(), `stop-plan-test-${process.pid}`);

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

const exec = (
  id: string,
  name: string,
  status: string,
  active = true,
  extra: Record<string, unknown> = {},
) => ({
  _id: id,
  name,
  status,
  active_on_server: active,
  ...extra,
});
const TODAY = '2026-10-20';
const byPrefix = toolMatcher([]);

test('AlgoTest: parse the live list (an array, or {data}), strategy id and deploy day', () => {
  const list = [
    exec('6ad590af06a3aebabc43634d', 'T1 · X', A_LIVE, true, {
      strategy_id: '6ad590af06a3aebabc436300',
      creation_ts: 1792469700, // 2026-10-20 09:45 IST, in seconds
    }),
  ];
  const [e] = parseExecutions(list);
  assert.equal(e?.activeOnServer, true);
  assert.equal(e?.strategyId, '6ad590af06a3aebabc436300');
  assert.equal(e?.createdDay, TODAY);
  assert.equal(parseExecutions({ data: list })[0]?.name, 'T1 · X');
  assert.equal(parseExecutions([exec('a', 'x', A_LIVE)])[0]?.createdDay, null);
  assert.throws(() => parseExecutions({}), /not an array/);
  assert.throws(() => parseExecutions([{ name: 'x' }]), /without _id/);
});

test("AlgoTest: the tool's deploys by the uploader ledger's id or name, the prefix as fallback", () => {
  const ledger: LedgerRow[] = [
    {
      at: 'x',
      day: TODAY,
      book: 't1',
      mode: 'evening',
      action: 'upload',
      name: 'Renamed later',
      sha: 'a',
      ok: true,
      id: '6ad590af06a3aebabc436300',
    },
  ];
  const isTool = toolMatcher(ledger);
  const [byId, byName, byPfx, mine] = parseExecutions([
    exec('1', 'anything', A_LIVE, true, { strategy: { _id: '6ad590af06a3aebabc436300' } }),
    exec('2', 'Renamed later', A_LIVE),
    exec('3', 'Core · X', A_LIVE),
    exec('4', 'my own', A_LIVE),
  ]);
  assert.deepEqual(
    [byId, byName, byPfx, mine].map((e) => isTool(e as never)),
    [true, true, true, false],
  );
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
    exec('8', 'T1 · Squaring', 'pending_square_off'),
    exec('9', 'T1 · Manual today', A_STOPPED, true, { creation_ts: '2026-10-20T04:00:00Z' }),
    exec('10', 'T1 · Manual undated', A_STOPPED),
    exec('11', 'T1 · Manual last week', A_STOPPED, true, { creation_ts: '2026-10-13T04:00:00Z' }),
  ]);
  assert.equal(canSquareOff(execs[2] as never), false);
  const p = planAlgoTestStop(execs, byPrefix, TODAY);
  const ids = (xs: Array<{ id: string }>) => xs.map((e) => e.id);
  assert.deepEqual(ids(p.squareOff), ['1', '2']);
  assert.deepEqual(ids(p.squaring), ['8']); // never "by hand": AlgoTest is exiting it
  assert.deepEqual(ids(p.byHand), ['3', '4']);
  assert.deepEqual(ids(p.check), ['9', '10']); // switched to manual: legs may be open
  assert.deepEqual(ids(p.notMine), ['6']);
  assert.equal(p.done, 2);
  assert.equal(squaringOff('PENDING_SQUARE_OFF'), true);
  assert.equal(squaringOff('pending_stop'), false);
});

test('AlgoTest outcome: only squared off is done; a square-off in flight is never "by hand"', () => {
  const w = (name: string, kind: Watched['kind'], at = '09:20'): Watched => ({
    name,
    at,
    kind,
    detail: kind === 'refused' ? 'answered 400' : undefined,
  });
  const watched = new Map<string, Watched>([
    ['1', w('T1 · A', 'sent')],
    ['2', w('T1 · B', 'sent')],
    ['3', w('T1 · C', 'sent')],
    ['4', w('T1 · D', 'sent')],
    ['5', w('T1 · E', 'maybe')],
    ['6', w('T1 · F', 'sent')],
    ['7', w('T1 · G', 'maybe')],
    ['8', w('T1 · H', 'refused')],
    ['9', w('T1 · I', 'sent', '09:01')],
  ]);
  (watched.get('9') as Watched).earlier = true;
  const r = algotestOutcome(
    watched,
    parseExecutions([
      exec('1', 'T1 · A', A_SQUARED_OFF),
      exec('2', 'T1 · B', A_STOPPED),
      exec('3', 'T1 · C', A_LIVE),
      exec('5', 'T1 · E', 'pending_square_off'), // no answer, yet AlgoTest is squaring it off
      exec('6', 'T1 · F', 'paused'),
      exec('7', 'T1 · G', A_LIVE),
      exec('8', 'T1 · H', A_LIVE),
      exec('9', 'T1 · I', 'pending_square_off'),
    ]),
  );
  assert.deepEqual(r.confirmed, ['T1 · A']);
  assert.deepEqual(r.closing, [
    'T1 · C (sent 09:20), AlgoTest still shows it StrategyStatus.Live',
    'T1 · E (sent 09:20)',
    'T1 · I (sent 09:01 by an earlier stop)',
  ]);
  assert.deepEqual(r.maybeOpen, ['T1 · G (sent 09:20)']);
  assert.deepEqual(r.refusedLive, ['T1 · H (answered 400)']);
  assert.match(r.check[0] ?? '', /T1 · B: switched to manual/);
  assert.match(r.check[1] ?? '', /T1 · D: no longer listed/);
  assert.match(
    r.other[0] ?? '',
    /T1 · F: square-off sent, AlgoTest now shows paused: .*do NOT exit/,
  );
});

test('stop rows: today and the next session of the algo weekday', () => {
  assert.deepEqual(stopSessions('2026-10-20', 'TUE'), ['2026-10-20']);
  assert.deepEqual(stopSessions('2026-10-20', 'WED'), ['2026-10-20', '2026-10-21']);
  assert.deepEqual(stopSessions('2026-10-20', 'MON'), ['2026-10-20', '2026-10-26']);
  assert.deepEqual(stopSessions('2026-10-20', 'ELSE'), ['2026-10-20']);
});

test('capped names a long list in part', () => {
  assert.equal(capped(['a', 'b'], 3), 'a, b');
  assert.equal(capped(['a', 'b', 'c', 'd'], 2), 'a, b and 2 more');
});

test('hold: in both places, persistent until cleared, found by the deployers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stop-hold-'));
  // never the real scheduler state dir
  const env = { TRADING_DATA_ROOT: root, SCHEDULER_STATE_DIR: join(root, 'state') };
  try {
    assert.equal(readHold(root, env), null);
    assert.equal(stopHeld(env), null);
    const w = await writeHold(root, 'test', new Date('2026-10-20T04:00:00Z'), env);
    assert.deepEqual(w.failed, []);
    // the scheduler reads these two paths
    assert.deepEqual(w.saved, [
      join(root, 'stop', 'HOLD.json'),
      join(root, 'state', 'stop-hold.json'),
    ]);
    assert.equal(holdPath(root), join(root, 'stop', 'HOLD.json'));
    assert.equal(stateHoldPath(env), join(root, 'state', 'stop-hold.json'));
    assert.equal(readHold(root, env)?.by, 'test');
    // a second stop keeps the first time
    await writeHold(root, 'again', new Date('2026-10-22T04:00:00Z'), env);
    assert.equal(readHold(root, env)?.at, '2026-10-20T04:00:00.000Z');
    assert.match(stopHeld(env) ?? '', /held by the stop button/);
    assert.equal(await clearHold(root, new Date(), env), true);
    assert.equal(readHold(root, env), null);
    assert.equal(await clearHold(root, new Date(), env), false);
    assert.ok((await readdir(join(root, 'stop'))).some((f) => f.startsWith('HOLD-cleared-')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hold: either copy holds; an unreadable one still holds; nowhere to save is said', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stop-hold-'));
  const env = { TRADING_DATA_ROOT: root, SCHEDULER_STATE_DIR: join(root, 'state') };
  try {
    // the data volume gone: the state copy alone holds
    const w = await writeHold(undefined, 'x', new Date(), env);
    assert.deepEqual(w.saved, [stateHoldPath(env)]);
    assert.match(w.failed.join(), /TRADING_DATA_ROOT is not set/);
    assert.match(stopHeld(env) ?? '', /held/);
    await writeFile(stateHoldPath(env), 'not json');
    assert.match(stopHeld(env) ?? '', /held/);
    // neither place writable
    await writeFile(join(root, 'blocked'), 'a file, not a folder');
    const none = await writeHold(join(root, 'blocked'), 'x', new Date(), {
      SCHEDULER_STATE_DIR: join(root, 'blocked', 'state'),
    });
    assert.deepEqual(none.saved, []);
    assert.equal(none.failed.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stop-running marker: {pid, at} beside each hold copy while a stop runs, gone after', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stop-run-'));
  const env = { SCHEDULER_STATE_DIR: join(root, 'state') };
  try {
    const paths = stopRunningPaths(root, env);
    assert.deepEqual(paths, [
      join(root, 'stop', 'stop-running.json'),
      join(root, 'state', 'stop-running.json'),
    ]);
    const mark = await markStopRunning(root, env);
    assert.equal(mark.conflict, null);
    for (const p of paths) {
      const m = JSON.parse(await readFile(p, 'utf8')) as { pid: number; at: string };
      assert.equal(m.pid, process.pid);
      assert.ok(m.at);
    }
    await mark.release();
    assert.deepEqual(
      paths.filter((p) => existsSync(p)),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('otherStopRunning: only a fresh, today, live marker of another process counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stop-run-'));
  const env = { SCHEDULER_STATE_DIR: join(root, 'state') };
  const now = new Date('2026-10-20T06:00:00Z'); // 11:30 IST
  const marker = join(root, 'stop', 'stop-running.json');
  const put = (pid: number, at: string) => writeFile(marker, JSON.stringify({ pid, at }));
  try {
    await mkdir(join(root, 'stop'), { recursive: true });
    // a week old, pid 1 (always alive: launchd): stale, whatever the pid
    await put(1, '2026-10-13T04:00:00Z');
    assert.equal(otherStopRunning(root, env, now), null);
    // today, 25 minutes old: past the runner's timeout, stale
    await put(process.ppid, '2026-10-20T05:35:00Z');
    assert.equal(otherStopRunning(root, env, now), null);
    // fresh, another live process (this test's parent): running
    await put(process.ppid, '2026-10-20T05:55:00Z');
    assert.deepEqual(otherStopRunning(root, env, now), {
      pid: process.ppid,
      since: '2026-10-20 11:25',
      path: marker,
    });
    // fresh but this very process: not another stop
    await put(process.pid, '2026-10-20T05:55:00Z');
    assert.equal(otherStopRunning(root, env, now), null);
    // fresh but a dead pid
    await put(999999, '2026-10-20T05:55:00Z');
    assert.equal(otherStopRunning(root, env, now), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('markStopRunning: a live marker is a conflict (nothing marked); a stale one is replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stop-run-'));
  const env = { SCHEDULER_STATE_DIR: join(root, 'state') };
  const marker = join(root, 'stop', 'stop-running.json');
  try {
    await mkdir(join(root, 'stop'), { recursive: true });
    const now = new Date();
    await writeFile(marker, JSON.stringify({ pid: process.ppid, at: now.toISOString() }));
    const busy = await markStopRunning(root, env, now);
    assert.equal(busy.conflict?.pid, process.ppid);
    assert.equal(existsSync(join(root, 'state', 'stop-running.json')), false);
    // stale (a week old): replaced by this run's own
    await writeFile(marker, JSON.stringify({ pid: 1, at: '2026-10-13T04:00:00Z' }));
    const mine = await markStopRunning(root, env, now);
    assert.equal(mine.conflict, null);
    assert.equal((JSON.parse(await readFile(marker, 'utf8')) as { pid: number }).pid, process.pid);
    mine.releaseSync();
    assert.equal(existsSync(marker), false);
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
