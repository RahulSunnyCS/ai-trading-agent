import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_AUTOMATION, quantiplyDeploy } from './automation-settings.js';
import {
  type AlgoDetail,
  ENABLE_LEAD_SECONDS,
  type EnableInput,
  defaultSession,
  istSeconds,
  parseBrokers,
  parseDetail,
  pickBroker,
  planDisable,
  planEnable,
  refuseEnable,
  staleEnabled,
  summaryEnable,
  verifyToggles,
} from './quantiply-deploy-plan.js';
import type { QAlgo, QLedgerRow } from './quantiply-plan.js';

const P = 'Core · ';
const WED = '2026-10-21';
const created = (id: string, name: string, day = WED, sha = 'a', weekday = 'WED'): QLedgerRow => ({
  at: '2026-10-19T11:55:27Z',
  day,
  weekday,
  mode: 'evening',
  action: 'create',
  id,
  name,
  sha,
  ok: true,
});
const algo = (id: string, name: string, over: Partial<QAlgo> = {}): QAlgo => ({
  id,
  name,
  day: 'WED',
  enabled: false,
  status: 'NOT_RUNNING',
  ...over,
});
const detail = (id: string, over: Partial<AlgoDetail> = {}): AlgoDetail => ({
  id,
  day: 'WED',
  enabled: false,
  status: 'NOT_RUNNING',
  startTime: '12:02:00',
  broker: '',
  diffs: [],
  ...over,
});
const HM = (h: number, m: number) => h * 3600 + m * 60;

/** Monday evening, enabling Wednesday's three Core picks (the 2026-10-19 upload). */
function wednesday(over: Partial<EnableInput> = {}): EnableInput {
  const names = [`${P}S_ditm1_1202`, `${P}S_p250_1317`, `${P}S_p250_1302`];
  return {
    session: WED,
    today: '2026-10-19',
    nowSeconds: HM(16, 55),
    picks: new Map(names.map((n) => [n, 'a'])),
    ledger: names.map((n, i) => created(String(i + 1), n)),
    algos: [...names.map((n, i) => algo(String(i + 1), n)), algo('own', 'N_ITM1_SL21_3000')],
    details: new Map(['1', '2', '3'].map((id) => [id, detail(id)])),
    brokerId: 'B1',
    ...over,
  };
}

test('enable: the session picks the uploader made, each set to the account broker', () => {
  const p = planEnable(wednesday());
  assert.equal(p.refused, null);
  assert.deepEqual(
    p.enable.map((t) => [t.id, t.setBroker]),
    [
      ['1', true],
      ['2', true],
      ['3', true],
    ],
  );
  assert.equal(summaryEnable(p).attention, false);
});

test('enable never touches an algo outside the ledger, even with a pick name', () => {
  const input = wednesday();
  input.algos.push(algo('hand', `${P}S_p250_1317`, { day: 'THU' }));
  input.ledger.push({ ...created('x', `${P}S_p250_1317`), ok: false });
  const p = planEnable(input);
  assert.ok(!p.enable.some((t) => t.id === 'hand' || t.id === 'x'));
  assert.ok(!p.dropped.some((t) => t.id === 'own'));
});

test("enable only the ledger's session, on the session's weekday", () => {
  const input = wednesday({
    ledger: [
      created('1', `${P}S_ditm1_1202`),
      created('2', `${P}S_p250_1317`, '2026-10-28'), // next week's
      created('3', `${P}S_p250_1302`, WED, 'a', 'THU'), // the ledger's weekday is wrong
    ],
  });
  input.algos[0] = algo('1', `${P}S_ditm1_1202`, { day: 'THU' }); // Quantiply says THU
  const p = planEnable(input);
  assert.deepEqual(p.enable, []);
  assert.equal(p.wrongDay.length, 2);
  assert.deepEqual(p.missing, [`${P}S_ditm1_1202`, `${P}S_p250_1317`, `${P}S_p250_1302`]);
  assert.equal(summaryEnable(p).attention, true);
});

test('already enabled, another broker, changed content, a mismatch at upload: not enabled', () => {
  const input = wednesday();
  input.algos[0] = algo('1', `${P}S_ditm1_1202`, { enabled: true });
  input.details.set('2', detail('2', { broker: 'OTHER' }));
  input.ledger[2] = created('3', `${P}S_p250_1302`, WED, 'mismatch:a');
  const p = planEnable(input);
  assert.deepEqual(p.already, [`${P}S_ditm1_1202`]);
  assert.deepEqual(p.brokerDiffers, [`${P}S_p250_1317`]);
  assert.match(p.differs[0] ?? '', /read-back differed at upload/);
  assert.deepEqual(p.enable, []);

  const changed = wednesday();
  changed.details.set('1', detail('1', { diffs: ['configurations.startTime'] }));
  changed.picks.set(`${P}S_p250_1317`, 'b');
  const q = planEnable(changed);
  assert.equal(q.differs.length, 2);
  assert.deepEqual(
    q.enable.map((t) => t.id),
    ['3'],
  );
});

test('the account broker already set is kept; a running status is not enabled', () => {
  const input = wednesday();
  input.details.set('1', detail('1', { broker: 'B1' }));
  input.algos[1] = algo('2', `${P}S_p250_1317`, { status: 'TRADE_ACTIVE' });
  const p = planEnable(input);
  assert.deepEqual(
    p.enable.map((t) => [t.id, t.setBroker]),
    [
      ['1', false],
      ['3', true],
    ],
  );
  assert.match(p.unexpected[0] ?? '', /TRADE_ACTIVE/);
});

test('two copies of one pick: neither is enabled', () => {
  const input = wednesday();
  input.ledger.push(created('4', `${P}S_p250_1302`));
  input.algos.push(algo('4', `${P}S_p250_1302`));
  input.details.set('4', detail('4'));
  const p = planEnable(input);
  assert.deepEqual(p.duplicates, [`${P}S_p250_1302`]);
  assert.ok(!p.enable.some((t) => t.id === '3' || t.id === '4'));
});

test('today: TOO LATE within the lead of a start, for that algo only', () => {
  const lead = ENABLE_LEAD_SECONDS;
  const input = wednesday({ today: WED, nowSeconds: HM(12, 2) - lead + 1 });
  input.details.set('2', detail('2', { startTime: '13:17:00' }));
  input.details.set('3', detail('3', { startTime: '13:02:00' }));
  const p = planEnable(input);
  assert.deepEqual(p.tooLate, [`${P}S_ditm1_1202 (12:02:00)`]);
  assert.deepEqual(
    p.enable.map((t) => t.id),
    ['2', '3'],
  );
  const inTime = planEnable(wednesday({ today: WED, nowSeconds: HM(12, 2) - lead }));
  assert.equal(inTime.tooLate.length, 0);
});

test('09:16 dropped a pick: its enabled algo is disabled, unless it may have started', () => {
  const input = wednesday({ today: WED, nowSeconds: HM(9, 21) });
  input.picks.delete(`${P}S_p250_1302`);
  input.picks.set(`${P}N_new_0930`, 'a');
  input.algos[2] = algo('3', `${P}S_p250_1302`, { enabled: true });
  input.details.set('3', detail('3', { startTime: '13:02:00', enabled: true }));
  let p = planEnable(input);
  assert.deepEqual(
    p.dropped.map((t) => t.id),
    ['3'],
  );
  assert.deepEqual(p.missing, [`${P}N_new_0930`]);

  input.details.set('3', detail('3', { startTime: '09:20:00', enabled: true }));
  p = planEnable(input);
  assert.deepEqual(p.dropped, []);
  assert.deepEqual(p.droppedLive, [`${P}S_p250_1302`]);
  assert.equal(summaryEnable(p).attention, true);

  input.algos[2] = algo('3', `${P}S_p250_1302`); // not enabled: left alone
  p = planEnable(input);
  assert.deepEqual(p.notPicked, [`${P}S_p250_1302`]);
});

test('the run is refused for a past session, a week ahead, or after the close', () => {
  assert.match(refuseEnable('2026-10-19', '2026-10-20', 0) ?? '', /past/);
  // Wed -> next Wed: Quantiply would run it TODAY
  assert.match(refuseEnable('2026-10-28', WED, HM(9, 0)) ?? '', /7 days ahead/);
  assert.equal(refuseEnable('2026-10-27', WED, HM(9, 0)), null);
  assert.match(refuseEnable(WED, WED, HM(15, 30)) ?? '', /over/);
  assert.equal(planEnable(wednesday({ today: '2026-10-22' })).enable.length, 0);
});

test('the default session: today until 15:30 on a trading day, else the next one', () => {
  const trading = (d: string) => !['2026-10-20', '2026-10-24', '2026-10-25'].includes(d);
  assert.equal(defaultSession('enable', '2026-10-19', HM(9, 21), trading).day, '2026-10-19');
  assert.equal(defaultSession('enable', '2026-10-19', HM(16, 55), trading).day, WED); // Tue a holiday
  assert.equal(defaultSession('enable', '2026-10-20', HM(10, 0), trading).day, WED);
  assert.equal(defaultSession('enable', '2026-10-23', HM(16, 55), trading).day, '2026-10-26');
  assert.equal(defaultSession('disable', '2026-10-19', HM(15, 40), trading).day, '2026-10-19');
});

test('disable: the session and older sessions, enabled and finished only', () => {
  const ledger = [
    created('1', `${P}A`, WED),
    created('2', `${P}B`, WED),
    created('3', `${P}C`, '2026-10-14'), // last week, still enabled
    created('4', `${P}D`, '2026-10-22'), // tomorrow: untouched
    created('5', `${P}E`, WED),
  ];
  const algos = [
    algo('1', `${P}A`, { enabled: true, status: 'TRADE_CLOSED' }),
    algo('2', `${P}B`),
    algo('3', `${P}C`, { enabled: true }),
    algo('4', `${P}D`, { enabled: true, day: 'THU' }),
    algo('5', `${P}E`, { enabled: true, status: 'TRADE_ACTIVE' }),
    algo('own', 'mine', { enabled: true }),
  ];
  const p = planDisable(WED, WED, ledger, algos);
  assert.deepEqual(
    p.disable.map((t) => t.id),
    ['1', '3'],
  );
  assert.deepEqual(p.off, [`${P}B`]);
  assert.deepEqual(p.live, [`${P}E (TRADE_ACTIVE)`]);
  // the owner's undo before the session: a future session's algos
  assert.deepEqual(
    planDisable('2026-10-22', WED, ledger, algos).disable.map((t) => t.id),
    ['3', '4'],
  );
});

test('check: owned algos enabled after their session', () => {
  const ledger = [created('1', `${P}A`, WED), created('2', `${P}B`, '2026-10-22')];
  const algos = [algo('1', `${P}A`, { enabled: true }), algo('2', `${P}B`, { enabled: true })];
  assert.deepEqual(staleEnabled(WED, HM(15, 0), ledger, algos), []);
  assert.equal(staleEnabled(WED, HM(15, 31), ledger, algos).length, 1);
  assert.equal(staleEnabled('2026-10-22', HM(9, 0), ledger, algos).length, 1);
});

test('verify: exactly the intended algos changed, nothing else', () => {
  const before = [algo('1', 'a'), algo('2', 'b'), algo('own', 'mine', { enabled: true })];
  const ok = [
    algo('1', 'a', { enabled: true }),
    algo('2', 'b'),
    algo('own', 'mine', { enabled: true }),
  ];
  assert.deepEqual(verifyToggles(before, ok, new Map([['1', true]])), []);

  assert.match(
    verifyToggles(before, before, new Map([['1', true]]))[0] ?? '',
    /a \(WED\) is disabled, expected ENABLED/,
  );
  const other = [
    algo('1', 'a', { enabled: true }),
    algo('2', 'b', { enabled: true }),
    before[2] as QAlgo,
  ];
  assert.match(
    verifyToggles(before, other, new Map([['1', true]]))[0] ?? '',
    /b \(WED\) changed to ENABLED, not by this run/,
  );
  const appeared = [...ok, algo('9', 'new', { enabled: true })];
  assert.match(
    verifyToggles(before, appeared, new Map([['1', true]]))[0] ?? '',
    /appeared ENABLED/,
  );
  const failed = verifyToggles(before, ok, new Map(), new Set(['1']));
  assert.match(failed[0] ?? '', /the call failed; Quantiply now shows it ENABLED/);
  assert.match(
    verifyToggles(before, [algo('2', 'b')], new Map([['1', true]]))[0] ?? '',
    /no longer listed/,
  );
});

test('the broker: exactly one enabled account with the login client code', () => {
  const list = parseBrokers({
    status: 'success',
    data: [
      { id: 'B1', clientId: 'r123', status: 'enabled' },
      { _id: 'F1', clientId: 'forward-testing', status: 'enabled' },
    ],
  });
  assert.deepEqual(pickBroker(list, 'R123'), { id: 'B1' });
  assert.ok('error' in pickBroker(list, 'X9'));
  assert.ok('error' in pickBroker([...list, { id: 'B2', clientId: 'R123', status: '' }], 'R123'));
  assert.ok('error' in pickBroker([{ id: 'B1', clientId: 'R123', status: 'disabled' }], 'R123'));
  assert.throws(() => parseBrokers({}), /no data array/);
});

test('parseDetail reads the start time, broker and state of GET /algos/:id', () => {
  const d = parseDetail({
    _id: '1',
    day: 'WED',
    enabled: false,
    status: 'NOT_RUNNING',
    configurations: { startTime: '12:02:00' },
  });
  assert.deepEqual(d, {
    id: '1',
    day: 'WED',
    enabled: false,
    status: 'NOT_RUNNING',
    startTime: '12:02:00',
    broker: '',
  });
  assert.equal(parseDetail({ configurations: { startTime: 'soon' } }).startTime, null);
  assert.equal(istSeconds(new Date('2026-10-21T06:32:00Z')), HM(12, 2));
});

test('enabling needs the deploy switch and the account row uploading a list', () => {
  const a = JSON.parse(JSON.stringify(DEFAULT_AUTOMATION)) as typeof DEFAULT_AUTOMATION;
  assert.equal(quantiplyDeploy(a, 'angelone').ok, false); // deploy is off by default
  a.masters.deploy = true;
  assert.deepEqual(quantiplyDeploy(a, 'angelone'), { ok: true, book: 'core', why: '' });
  assert.equal(quantiplyDeploy(a, 'finvasia').ok, false);
  a.masters.uploads = false;
  assert.equal(quantiplyDeploy(a, 'angelone').ok, false);
});
