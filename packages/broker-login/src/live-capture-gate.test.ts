import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureGate, heldLine, holdDeletes } from './live-capture-gate.js';

const DAY = '2026-10-21';
const section = (platform: string, broker: string, ok: boolean) =>
  JSON.stringify({
    kind: 'section',
    day: DAY,
    platform,
    broker,
    ok,
    error: ok ? null : 'x',
    strategies: 0,
    captured_at: '',
  });

function root(lines?: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'live-gate-'));
  if (lines) {
    mkdirSync(join(dir, 'rotation', 'live'), { recursive: true });
    if (lines.length)
      writeFileSync(join(dir, 'rotation', 'live', `${DAY}.jsonl`), `${lines.join('\n')}\n`);
  }
  return dir;
}

test('before the capture ever ran, nothing is held', () => {
  assert.equal(captureGate(root(), DAY, 'algotest').hold, false);
});

test("no file for today, or a failed section, holds that platform's deletes", () => {
  assert.deepEqual(captureGate(root([]), DAY, 'algotest'), {
    hold: true,
    why: `no live capture for ${DAY} yet`,
  });
  const r = root([section('algotest', 'all', true), section('quantiply', 'angelone', false)]);
  assert.equal(captureGate(r, DAY, 'algotest').hold, false);
  assert.equal(captureGate(r, DAY, 'quantiply', 'angelone').hold, true);
  assert.equal(captureGate(r, DAY, 'quantiply', 'finvasia').hold, true);
});

test('held deletes take their same-name replacements with them, other uploads go', () => {
  const h = holdDeletes(
    ['T1 · a', 'T1 · b'],
    [{ name: 'T1 · a' }, { name: 'T1 · c' }],
    (n) => n,
    (u) => u.name,
  );
  assert.deepEqual(h.deletes, []);
  assert.deepEqual(h.uploads, [{ name: 'T1 · c' }]);
  assert.deepEqual(h.heldUploads, ['T1 · a']);
  assert.match(
    heldLine('why', h.held, h.heldUploads),
    /^⏸ deletes held \(why; .*T1 · a, T1 · b; replacing T1 · a waits too/,
  );
  // nothing to delete: nothing changes
  const none = holdDeletes(
    [],
    [{ name: 'x' }],
    (n: string) => n,
    (u) => u.name,
  );
  assert.deepEqual(none.uploads, [{ name: 'x' }]);
});
