import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { quantiplyDeployLedgerPath, takeLoginLock } from './quantiply-session.js';

test('one Quantiply login per account at a time; the next waits for the release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qlock-'));
  try {
    const release = await takeLoginLock(dir, 'angelone');
    let second = false;
    const waiting = takeLoginLock(dir, 'angelone', { pollMs: 5 }).then((r) => {
      second = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(second, false, 'waits while the first holds the lock');
    // another account is not held up
    const other = await takeLoginLock(dir, 'finvasia', { waitMs: 0 });
    await other();
    await release();
    await (await waiting)();
    assert.equal(second, true);
    assert.equal(existsSync(join(dir, 'login-lock-angelone')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a crashed run's lock is taken over; a stuck one never blocks past the wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qlock-'));
  try {
    // a dead pid: taken over at once
    await writeFile(
      join(dir, 'login-lock-angelone'),
      JSON.stringify({ pid: 999999, at: Date.now() }),
    );
    await (await takeLoginLock(dir, 'angelone', { waitMs: 0 }))();
    // a live pid (this one): goes ahead after the wait
    await writeFile(
      join(dir, 'login-lock-angelone'),
      JSON.stringify({ pid: process.pid, at: Date.now() }),
    );
    const started = Date.now();
    await (await takeLoginLock(dir, 'angelone', { waitMs: 30, pollMs: 5 }))();
    assert.ok(Date.now() - started >= 25);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stale lock is taken over by one waiter only; the others wait their turn', async () => {
  for (let trial = 0; trial < 30; trial += 1) {
    const dir = await mkdtemp(join(tmpdir(), 'qlock-'));
    try {
      await writeFile(
        join(dir, 'login-lock-angelone'),
        JSON.stringify({ pid: 999999, at: Date.now() }),
      );
      let inside = 0;
      let most = 0;
      await Promise.all(
        [1, 2, 3].map(async () => {
          const release = await takeLoginLock(dir, 'angelone', { pollMs: 1, waitMs: 5_000 });
          inside += 1;
          most = Math.max(most, inside);
          await new Promise((r) => setTimeout(r, 5));
          inside -= 1;
          await release();
        }),
      );
      assert.equal(most, 1, `trial ${trial}: two holders at once`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('a release removes only its own lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qlock-'));
  try {
    const release = await takeLoginLock(dir, 'angelone');
    // taken over meanwhile by another run
    const theirs = JSON.stringify({ pid: process.pid, at: Date.now(), token: 'theirs' });
    await writeFile(join(dir, 'login-lock-angelone'), theirs);
    await release();
    assert.equal(existsSync(join(dir, 'login-lock-angelone')), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the deploy ledger name is the one rule for the enabler and the stop', () => {
  assert.equal(quantiplyDeployLedgerPath('/d', 'angelone'), join('/d', 'deploy-ledger.jsonl'));
  assert.equal(
    quantiplyDeployLedgerPath('/d', 'finvasia'),
    join('/d', 'deploy-ledger-finvasia.jsonl'),
  );
});
