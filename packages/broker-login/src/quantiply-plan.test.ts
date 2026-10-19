import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  type QAlgo,
  type QLedgerRow,
  type QWanted,
  istWeekday,
  ownedIds,
  parseDayWise,
  parseQLedger,
  planQ,
  readBackDiffs,
  summaryQ,
} from './quantiply-plan.js';

const P = 'Core · ';
const row = (action: 'create' | 'delete', id: string, name: string, sha = 'a', ok = true) =>
  ({
    at: '2026-10-19T16:45:00+05:30',
    day: '2026-10-21',
    weekday: 'WED',
    mode: 'evening',
    action,
    id,
    name,
    sha,
    ok,
  }) satisfies QLedgerRow;
const want = (name: string, sha = 'a', unconfirmed: string[] = []): QWanted => ({
  name,
  variant: name,
  file: `${name}.json`,
  sha,
  unconfirmed,
});
const algo = (id: string, name: string, day: string, over: Partial<QAlgo> = {}): QAlgo => ({
  id,
  name,
  day,
  enabled: false,
  status: 'NOT_RUNNING',
  ...over,
});

test('ownedIds follows the last successful action per id and ignores other names', () => {
  const ledger = [
    row('create', '1', `${P}A`),
    row('create', '2', `${P}B`),
    row('delete', '2', `${P}B`),
    row('create', '3', `${P}C`, 'x', false),
    row('create', '4', 'N_ITM1_SL21_3000'),
  ];
  assert.deepEqual([...ownedIds(ledger).keys()], ['1']);
});

test('evening: keeps the unchanged, deletes the dropped, creates the missing', () => {
  const ledger = [row('create', '1', `${P}A`), row('create', '2', `${P}B`)];
  const algos = [algo('1', `${P}A`, 'WED'), algo('2', `${P}B`, 'MON', { status: 'TRADE_CLOSED' })];
  const p = planQ('evening', 'WED', 'MON', [want(`${P}A`), want(`${P}C`)], ledger, algos);
  assert.deepEqual(p.keep, [`${P}A`]);
  assert.deepEqual(
    p.delete.map((a) => a.id),
    ['2'],
  );
  assert.deepEqual(
    p.create.map((w) => w.name),
    [`${P}C`],
  );
});

test("evening never touches the owner's algos, a running one or one enabled for a later day", () => {
  const ledger = [
    row('create', '1', `${P}A`),
    row('create', '2', `${P}B`),
    row('create', '3', `${P}C`),
  ];
  const algos = [
    algo('1', `${P}A`, 'MON', { enabled: true, status: 'RUNNING' }),
    algo('2', `${P}B`, 'FRI', { enabled: true }),
    algo('3', `${P}C`, 'MON', { enabled: true, status: 'TRADE_CLOSED' }),
    algo('9', `${P}X`, 'WED'),
    algo('8', 'N_ITM1_SL21_3000', 'MON', { status: 'TRADE_CLOSED' }),
  ];
  const p = planQ('evening', 'WED', 'MON', [want(`${P}X`)], ledger, algos);
  assert.deepEqual(
    p.heldBack.map((a) => a.id),
    ['1', '2'],
  );
  assert.deepEqual(
    p.delete.map((a) => a.id),
    ['3'], // enabled, but for today, and finished
  );
  assert.deepEqual(p.conflicts, [`${P}X`]);
  assert.deepEqual(p.create, []);
});

test('the same name on another weekday is not a match for the wanted day', () => {
  const ledger = [row('create', '1', `${P}A`)];
  const algos = [algo('1', `${P}A`, 'MON', { status: 'TRADE_CLOSED' })];
  const p = planQ('evening', 'WED', 'MON', [want(`${P}A`)], ledger, algos);
  assert.deepEqual(
    p.create.map((w) => w.name),
    [`${P}A`],
  );
  assert.deepEqual(
    p.delete.map((a) => a.id),
    ['1'],
  );
});

test('evening replaces an owned algo whose content changed, and a duplicate', () => {
  const ledger = [
    row('create', '1', `${P}A`, 'old'),
    row('create', '2', `${P}B`, 'b'),
    row('create', '3', `${P}B`, 'b'),
  ];
  const algos = [algo('1', `${P}A`, 'WED'), algo('2', `${P}B`, 'WED'), algo('3', `${P}B`, 'WED')];
  const p = planQ(
    'evening',
    'WED',
    'MON',
    [want(`${P}A`, 'new'), want(`${P}B`, 'b')],
    ledger,
    algos,
  );
  assert.deepEqual(
    p.delete.map((a) => a.id),
    ['1', '3'],
  );
  assert.deepEqual(
    p.create.map((w) => w.sha),
    ['new'],
  );
  assert.deepEqual(p.keep, [`${P}B`]);
});

test('top-up creates only what is missing on the day, deletes nothing, reports the rest', () => {
  const ledger = [
    row('create', '1', `${P}A`),
    row('create', '2', `${P}B`),
    row('create', '3', `${P}C`, 'old'),
  ];
  const algos = [algo('1', `${P}A`, 'WED'), algo('2', `${P}B`, 'WED'), algo('3', `${P}C`, 'WED')];
  const p = planQ(
    'topup',
    'WED',
    'WED',
    [want(`${P}A`), want(`${P}C`, 'new'), want(`${P}D`)],
    ledger,
    algos,
  );
  assert.deepEqual(
    p.create.map((w) => w.name),
    [`${P}D`],
  );
  assert.deepEqual(p.delete, []);
  assert.deepEqual(p.notToday, [`${P}B`]);
  assert.deepEqual(p.changed, [`${P}C`]);
  assert.deepEqual(p.keep, [`${P}A`]);
});

test('a pick with an unconfirmed setting is never created, and is reported', () => {
  const p = planQ(
    'evening',
    'WED',
    'MON',
    [want(`${P}N_buy_0932`, 'a', ['trail in points'])],
    [],
    [],
  );
  assert.deepEqual(p.create, []);
  assert.equal(p.unconfirmed.length, 1);
  assert.match(summaryQ(p, 'evening').join('\n'), /NOT created.*trail in points/);
});

test('parseDayWise flattens the weekday lists and rejects a strange shape', () => {
  const json = {
    data: [
      {
        day: 'MON',
        algos: [{ _id: 'a', name: 'X', day: 'MON', enabled: true, status: 'TRADE_CLOSED' }],
      },
      { day: 'TUE', algos: [] },
    ],
  };
  assert.deepEqual(parseDayWise(json), [
    { id: 'a', name: 'X', day: 'MON', enabled: true, status: 'TRADE_CLOSED' },
  ]);
  assert.throws(() => parseDayWise({ data: {} }), /no data array/);
  assert.throws(() => parseDayWise({ data: [{ day: 'MON', algos: [{ name: 'X' }] }] }), /_id/);
});

test('parseQLedger skips a torn line', () => {
  const text = `${JSON.stringify(row('create', '1', `${P}A`))}\n{"at":"2026-10-19T16:4`;
  assert.equal(parseQLedger(text).length, 1);
});

test('istWeekday is the IST day whatever the host zone', () => {
  assert.equal(istWeekday(new Date('2026-10-18T18:31:00Z')), 'MON'); // 00:01 IST Monday
  assert.equal(istWeekday(new Date('2026-10-18T18:29:00Z')), 'SUN');
});

// The owner's own save on 2026-10-19 and what Quantiply answered (tests/fixtures/quantiply/).
const FIX = new URL('../../option-backtesting/tests/fixtures/quantiply/', import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, FIX), 'utf8'));

test('read-back: the captured save comes back except the dropped matching modes', () => {
  assert.deepEqual(readBackDiffs(fixture('create_request'), fixture('create_response_first')), [
    'configurations.matching',
  ]);
});

test('read-back: server defaults are ignored, a changed or missing field is not', () => {
  const sent = fixture('create_request');
  sent.configurations.matching = [{ mode: 'NO_MATCHING', active: true }];
  const saved = fixture('create_response_first');
  assert.deepEqual(readBackDiffs(sent, saved), []);
  saved.configurations.legs[1].stoploss.value = -100;
  delete saved.configurations.endTime;
  assert.deepEqual(readBackDiffs(sent, saved), [
    'configurations.endTime',
    'configurations.legs[1].stoploss.value',
  ]);
});
