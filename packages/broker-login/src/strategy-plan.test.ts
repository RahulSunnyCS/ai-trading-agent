import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type LedgerRow,
  type Wanted,
  comparable,
  istToday,
  namesIn,
  owned,
  parseLedger,
  plan,
} from './strategy-plan.js';

const row = (action: 'upload' | 'delete', name: string, sha = 'a', ok = true): LedgerRow => ({
  at: '2026-10-19T16:40:00+05:30',
  day: '2026-10-20',
  book: 't1',
  mode: 'evening',
  action,
  name,
  sha,
  ok,
});
const want = (name: string, sha = 'a'): Wanted => ({
  name,
  variant: name,
  file: `${name}.algtst`,
  sha,
});

const P = 'T1 · ';

test('owned follows the last successful action and ignores names without the prefix', () => {
  const ledger = [
    row('upload', `${P}A`),
    row('upload', `${P}B`),
    row('delete', `${P}B`),
    row('upload', `${P}C`, 'x', false),
    row('upload', 'Nifty_Widesl_917_OTM1'),
  ];
  assert.deepEqual([...owned(ledger).keys()], [`${P}A`]);
});

test('evening: keeps the unchanged, deletes the dropped, uploads the missing', () => {
  const ledger = [row('upload', `${P}A`), row('upload', `${P}B`)];
  const p = plan(
    'evening',
    [want(`${P}A`), want(`${P}C`)],
    ledger,
    new Set([`${P}A`, `${P}B`]),
    new Set(),
  );
  assert.deepEqual(p.keep, [`${P}A`]);
  assert.deepEqual(p.delete, [`${P}B`]);
  assert.deepEqual(
    p.upload.map((w) => w.name),
    [`${P}C`],
  );
});

test("evening never deletes the owner's strategies or a deployed one", () => {
  const ledger = [row('upload', `${P}B`)];
  const existing = new Set([`${P}B`, 'Nifty_Widesl_917_OTM1', `${P}X`]);
  const p = plan('evening', [want(`${P}X`)], ledger, existing, new Set([`${P}B`]));
  assert.deepEqual(p.delete, []);
  assert.deepEqual(p.deployedKept, [`${P}B`]);
  assert.deepEqual(p.conflicts, [`${P}X`]);
  assert.deepEqual(p.upload, []);
});

test('evening replaces an owned strategy whose content changed', () => {
  const p = plan(
    'evening',
    [want(`${P}A`, 'new')],
    [row('upload', `${P}A`, 'old')],
    new Set([`${P}A`]),
    new Set(),
  );
  assert.deepEqual(p.delete, [`${P}A`]);
  assert.deepEqual(
    p.upload.map((w) => w.sha),
    ['new'],
  );
});

test('top-up uploads only what is missing, deletes nothing, reports not-today', () => {
  const ledger = [row('upload', `${P}A`), row('upload', `${P}B`), row('upload', `${P}C`, 'old')];
  const existing = new Set([`${P}A`, `${P}B`, `${P}C`]);
  const p = plan(
    'topup',
    [want(`${P}A`), want(`${P}C`, 'new'), want(`${P}D`)],
    ledger,
    existing,
    new Set(),
  );
  assert.deepEqual(
    p.upload.map((w) => w.name),
    [`${P}D`],
  );
  assert.deepEqual(p.delete, []);
  assert.deepEqual(p.notToday, [`${P}B`]);
  assert.deepEqual(p.changed, [`${P}C`]);
  assert.deepEqual(p.keep, [`${P}A`]);
});

test('a missing owned strategy is neither deleted nor reported', () => {
  const p = plan('evening', [], [row('upload', `${P}A`)], new Set(), new Set());
  assert.deepEqual(p.delete, []);
  assert.deepEqual(p.notToday, []);
});

test('parseLedger skips a torn line', () => {
  const text = `${JSON.stringify(row('upload', `${P}A`))}\n{"at":"2026-10-19T16:4`;
  assert.equal(parseLedger(text).length, 1);
});

test('namesIn finds names at any depth', () => {
  const json = {
    data: [{ _id: '1', name: `${P}A`, legs: [{ name: 'x' }] }, { strategy_name: 'B' }],
  };
  assert.deepEqual([...namesIn(json)].sort(), ['B', `${P}A`, 'x']);
});

test('comparable ignores leg ids, key order and the name', () => {
  const a = {
    name: 'one',
    strategy: { Ticker: 'NIFTY', ListOfLegConfigs: [{ id: 'aaaa', Lots: 1 }] },
  };
  const b = {
    name: 'two',
    strategy: { ListOfLegConfigs: [{ Lots: 1, id: 'bbbb' }], Ticker: 'NIFTY' },
  };
  assert.equal(comparable(a), comparable(b));
  const c = { strategy: { Ticker: 'NIFTY', ListOfLegConfigs: [{ id: 'aaaa', Lots: 2 }] } };
  assert.notEqual(comparable(a), comparable(c));
});

test('istToday rolls over at IST midnight, not UTC', () => {
  assert.equal(istToday(new Date('2026-10-18T18:29:00Z')), '2026-10-18');
  assert.equal(istToday(new Date('2026-10-18T18:31:00Z')), '2026-10-19');
});
