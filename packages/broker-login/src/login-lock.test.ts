import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  LockBusy,
  isStale,
  lastLoginAt,
  lockDir,
  tryLock,
  unlock,
  withLoginLock,
} from './login-lock.js';
import { claimedWindow, lastTotpLoginAt } from './quantiply-session.js';

const dir = () => mkdtempSync(join(tmpdir(), 'bl143-lock-'));

test('lockDir: TRADING_DATA_ROOT/locks, else the scheduler state folder', () => {
  assert.equal(lockDir({ TRADING_DATA_ROOT: '/Volumes/T' }), '/Volumes/T/locks');
  assert.equal(lockDir({ SCHEDULER_STATE_DIR: '/s' }), '/s/locks');
});

test('a holder is stale when its process is gone, it is too old, or unreadable', () => {
  const now = Date.parse('2026-10-21T04:00:00Z');
  const h = { pid: 123, at: '2026-10-21T03:59:00Z', who: 'x' };
  assert.equal(
    isStale(h, now, 600_000, () => true),
    false,
  );
  assert.equal(
    isStale(h, now, 600_000, () => false),
    true,
  );
  assert.equal(
    isStale(h, now, 30_000, () => true),
    true,
  );
  assert.equal(
    isStale(null, now, 600_000, () => true),
    true,
  );
});

test('tryLock: one holder; a dead holder is taken over; unlock only by the holder', () => {
  const path = join(dir(), 'l.lock');
  assert.equal(tryLock(path, 'a', 600_000), true);
  assert.equal(tryLock(path, 'b', 600_000), false); // this process holds it, alive
  unlock(path);
  writeFileSync(
    path,
    JSON.stringify({ pid: 999_999_999, at: new Date().toISOString(), who: 'dead' }),
  );
  assert.equal(tryLock(path, 'c', 600_000), true);
  unlock(path);
});

test('withLoginLock runs one login at a time and gives up after its wait', async () => {
  const d = dir();
  const order: string[] = [];
  const slow = withLoginLock(
    'algotest',
    'first',
    async () => {
      order.push('first start');
      await new Promise((r) => setTimeout(r, 300));
      order.push('first end');
    },
    { dir: d },
  );
  await new Promise((r) => setTimeout(r, 20));
  // the same process holds the lock: a second taker waits, then times out
  await assert.rejects(
    withLoginLock('algotest', 'second', async () => undefined, { dir: d, waitMs: 50 }),
    LockBusy,
  );
  await slow;
  assert.deepEqual(order, ['first start', 'first end']);
  await withLoginLock('algotest', 'third', async () => order.push('third'), { dir: d });
  assert.equal(order.at(-1), 'third');
});

test('the TOTP claim is the next window near the end of one', () => {
  const w = Math.floor(1_760_000_010_000 / 30_000);
  assert.equal(claimedWindow(w * 30_000 + 1_000), w);
  assert.equal(claimedWindow(w * 30_000 + 27_000), w + 1);
});

test("every login under the lock stamps when it ended, failed or not (the monitor's B check)", async () => {
  const d = dir();
  assert.equal(lastLoginAt('algotest', d), null);
  const before = Date.now();
  await assert.rejects(
    withLoginLock(
      'algotest',
      'uploader',
      async () => {
        throw new Error('login failed');
      },
      { dir: d },
    ),
  );
  const at = lastLoginAt('algotest', d);
  assert.ok(at !== null && at >= before && at <= Date.now());
  // the asking process's own login is not "another" one
  assert.equal(lastLoginAt('algotest', d, process.pid), null);
  // a login refused inside the lock (it never got as far as logging in) leaves the stamp alone
  const stamped = lastLoginAt('algotest', d);
  await new Promise((r) => setTimeout(r, 5));
  await withLoginLock('algotest', 'trade-monitor', async () => undefined, {
    dir: d,
    stampIf: () => false,
  });
  assert.equal(lastLoginAt('algotest', d), stamped);
});

test("Quantiply's last code typed is read from the TOTP window stamp", async () => {
  const d = dir();
  assert.equal(await lastTotpLoginAt(d, 'angelone'), null);
  writeFileSync(join(d, 'totp-window-angelone.json'), JSON.stringify({ window: 58_000_000 }));
  assert.equal(await lastTotpLoginAt(d, 'angelone'), 58_000_000 * 30_000);
});
