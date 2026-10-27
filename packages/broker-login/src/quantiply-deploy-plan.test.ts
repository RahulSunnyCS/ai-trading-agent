import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import { DEFAULT_AUTOMATION, quantiplyDeploy } from './automation-settings.js';
import {
  type AlgoDetail,
  ENABLE_LEAD_SECONDS,
  type EnableInput,
  UNKNOWN_BROKER,
  clientwiseBody,
  clientwiseHolds,
  clientwiseNow,
  defaultSession,
  enabledSessions,
  istSeconds,
  ownedForSession,
  parseClientwise,
  parseBroker,
  parseBrokers,
  parseDeployLedger,
  parseDetail,
  pickBroker,
  planDisable,
  planEnable,
  refuseEnable,
  staleEnabled,
  summaryEnable,
  toggledIds,
  verifyToggles,
} from './quantiply-deploy-plan.js';
import { type QAlgo, type QLedgerRow, parseQLedger } from './quantiply-plan.js';

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
  assert.ok(!p.disable.some((t) => t.id === 'own'));
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
  // uploaded, on the wrong weekday: never "not uploaded"; next week's copy is not this session's
  assert.deepEqual(p.missing, [`${P}S_p250_1317`]);
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
    p.disable.map((t) => [t.id, t.alert]),
    [['3', false]],
  );
  assert.deepEqual(p.missing, [`${P}N_new_0930`]);

  input.details.set('3', detail('3', { startTime: '09:20:00', enabled: true }));
  p = planEnable(input);
  assert.deepEqual(p.disable, []);
  assert.match(p.enabledLive[0] ?? '', /S_p250_1302 \(ENABLED and no longer a pick/);
  assert.equal(summaryEnable(p).attention, true);

  input.algos[2] = algo('3', `${P}S_p250_1302`); // not enabled: left alone
  input.details.set('3', detail('3', { startTime: '09:20:00' }));
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
  const close = { nowSeconds: HM(15, 40) };
  const p = planDisable(WED, WED, ledger, algos, close);
  assert.deepEqual(
    p.disable.map((t) => t.id),
    ['1', '3'],
  );
  assert.deepEqual(p.off, [`${P}B`]);
  assert.deepEqual(p.live, [`${P}E (TRADE_ACTIVE)`]);
  // the owner's undo before the session: a future session's algos
  assert.deepEqual(
    planDisable('2026-10-22', WED, ledger, algos, close).disable.map((t) => t.id),
    ['3', '4'],
  );
});

test("disable leaves today's algos on until 15:30, unless it is the emergency stop", () => {
  const ledger = [created('1', `${P}A`, WED), created('4', `${P}D`, '2026-10-22')];
  const algos = [
    algo('1', `${P}A`, { enabled: true }),
    algo('4', `${P}D`, { enabled: true, day: 'THU' }),
  ];
  const morning = planDisable(WED, WED, ledger, algos, { nowSeconds: HM(11, 0) });
  assert.deepEqual(morning.disable, []);
  assert.deepEqual(morning.notYet, [`${P}A`]);
  const stop = planDisable(WED, WED, ledger, algos, { nowSeconds: HM(11, 0), emergency: true });
  assert.deepEqual(
    stop.disable.map((t) => t.id),
    ['1'],
  );
  // tomorrow's (the undo of an evening enable) is not today's: switched off at any time
  assert.deepEqual(
    planDisable('2026-10-22', WED, ledger, algos, { nowSeconds: HM(11, 0) }).disable.map(
      (t) => t.id,
    ),
    ['4'],
  );
});

test('check: owned algos enabled after their session', () => {
  const ledger = [created('1', `${P}A`, WED), created('2', `${P}B`, '2026-10-22')];
  const algos = [algo('1', `${P}A`, { enabled: true }), algo('2', `${P}B`, { enabled: true })];
  assert.deepEqual(staleEnabled(WED, HM(15, 0), ledger, algos), []);
  assert.equal(staleEnabled(WED, HM(15, 31), ledger, algos).length, 1);
  assert.equal(staleEnabled('2026-10-22', HM(9, 0), ledger, algos).length, 1);
});

test('verify: exactly the intended algos changed, nothing else of the tool', () => {
  const owned = new Set(['1', '2']);
  const before = [algo('1', 'a'), algo('2', 'b'), algo('own', 'mine', { enabled: true })];
  const ok = [
    algo('1', 'a', { enabled: true }),
    algo('2', 'b'),
    algo('own', 'mine', { enabled: true }),
  ];
  const v = (after: QAlgo[], intended: Map<string, boolean>, uncertain = new Set<string>()) =>
    verifyToggles(before, after, intended, uncertain, owned);
  assert.deepEqual(v(ok, new Map([['1', true]])), { problems: [], notes: [] });

  assert.match(
    v(before, new Map([['1', true]])).problems[0] ?? '',
    /a \(WED\) is disabled, expected ENABLED/,
  );
  const other = [
    algo('1', 'a', { enabled: true }),
    algo('2', 'b', { enabled: true }),
    before[2] as QAlgo,
  ];
  assert.match(
    v(other, new Map([['1', true]])).problems[0] ?? '',
    /b \(WED\) changed to ENABLED, not by this run/,
  );
  // the owner switching their own algo meanwhile is theirs: a note, never a stop
  const owner = [algo('1', 'a', { enabled: true }), algo('2', 'b'), algo('own', 'mine')];
  const o = v(owner, new Map([['1', true]]));
  assert.deepEqual(o.problems, []);
  assert.match(o.notes[0] ?? '', /mine \(WED\) changed to disabled/);
  const appeared = v([...ok, algo('9', 'new', { enabled: true })], new Map([['1', true]]));
  assert.deepEqual(appeared.problems, []);
  assert.match(appeared.notes[0] ?? '', /appeared ENABLED/);
  const failed = v(ok, new Map(), new Set(['1']));
  assert.match(failed.problems[0] ?? '', /the call failed; Quantiply now shows it ENABLED/);
  assert.match(v([algo('2', 'b')], new Map([['1', true]])).problems[0] ?? '', /no longer listed/);
});

test('never enabled again once this session switched it (the owner turned it off since)', () => {
  const rows = parseDeployLedger(
    [
      JSON.stringify({
        at: 'x',
        session: WED,
        mode: 'enable',
        action: 'broker',
        id: '3',
        name: 'c',
        ok: true,
      }),
      JSON.stringify({
        at: 'x',
        session: WED,
        mode: 'enable',
        action: 'enable',
        id: '1',
        name: 'a',
        ok: true,
      }),
      JSON.stringify({
        at: 'x',
        session: '2026-10-14',
        mode: 'enable',
        action: 'enable',
        id: '2',
        name: 'b',
        ok: true,
      }),
      '{"torn',
    ].join('\n'),
  );
  const toggled = toggledIds(rows, WED);
  assert.deepEqual([...toggled.keys()], ['1']);
  const p = planEnable(wednesday({ toggled }));
  assert.deepEqual(p.leftOff, [`${P}S_ditm1_1202`]);
  assert.deepEqual(
    p.enable.map((t) => t.id),
    ['2', '3'],
  );
  assert.equal(summaryEnable(p).attention, false);
  // still on: reported as already enabled, never toggled again
  const on = wednesday({ toggled });
  on.algos[0] = algo('1', `${P}S_ditm1_1202`, { enabled: true });
  assert.deepEqual(planEnable(on).already, [`${P}S_ditm1_1202`]);
});

test('an ENABLED algo that fails a check is switched off (or reported), never "not enabled"', () => {
  const input = wednesday({ today: WED, nowSeconds: HM(9, 21) });
  for (const id of ['1', '2', '3']) {
    input.algos[Number(id) - 1] = { ...(input.algos[Number(id) - 1] as QAlgo), enabled: true };
  }
  input.details.set(
    '1',
    detail('1', { diffs: ['configurations.legs[0].quantity'], enabled: true }),
  );
  input.details.set('2', detail('2', { broker: 'OTHER', startTime: '13:17:00', enabled: true }));
  input.details.set('3', detail('3', { startTime: '09:22:00', enabled: true })); // fine, enabled
  input.picks.set(`${P}S_p250_1302`, 'b'); // the recorded export differs from the uploaded copy
  const p = planEnable(input);
  assert.deepEqual(p.differs, []);
  assert.deepEqual(p.brokerDiffers, []);
  assert.deepEqual(
    p.disable.map((t) => [t.id, t.alert]),
    [
      ['1', true],
      ['2', true],
    ],
  );
  assert.match(p.disable[0]?.why ?? '', /content differs/);
  assert.match(p.enabledLive[0] ?? '', /S_p250_1302 \(ENABLED and content differs/); // starts 09:22
  const s = summaryEnable(p);
  assert.equal(s.attention, true);
  assert.ok(!s.lines.some((l) => l.includes('not enabled')));
});

test('an enabled duplicate or wrong-weekday algo of the session is switched off too', () => {
  const input = wednesday();
  input.ledger.push(created('4', `${P}S_p250_1302`));
  input.algos.push(algo('4', `${P}S_p250_1302`, { enabled: true }));
  input.details.set('4', detail('4', { enabled: true }));
  input.algos[0] = algo('1', `${P}S_ditm1_1202`, { day: 'THU', enabled: true });
  const p = planEnable(input);
  assert.deepEqual(p.disable.map((t) => t.id).sort(), ['1', '4']);
  assert.deepEqual(p.duplicates, [`${P}S_p250_1302`]);
});

test('a broker that is set but not a plain id is never overwritten', () => {
  assert.equal(parseBroker(null), '');
  assert.equal(parseBroker('B1'), 'B1');
  assert.equal(parseBroker(7), '7');
  assert.equal(parseBroker({ _id: 'B1', clientId: 'R1' }), 'B1');
  assert.equal(parseBroker({ clientId: 'R1' }), UNKNOWN_BROKER);
  assert.equal(parseBroker([1]), UNKNOWN_BROKER);
  const input = wednesday();
  input.details.set('1', detail('1', { broker: UNKNOWN_BROKER }));
  input.details.set('2', detail('2', { broker: parseBroker({ _id: 'B1' }) }));
  const p = planEnable(input);
  assert.deepEqual(p.brokerDiffers, [`${P}S_ditm1_1202`]);
  assert.deepEqual(
    p.enable.map((t) => [t.id, t.setBroker]),
    [
      ['2', false],
      ['3', true],
    ],
  );
});

test("a copy the uploader kept from an earlier week is this session's, with the pick's content", () => {
  const input = wednesday();
  input.ledger[1] = created('2', `${P}S_p250_1317`, '2026-10-14'); // last Wednesday's, same sha
  let p = planEnable(input);
  assert.deepEqual(
    p.enable.map((t) => t.id),
    ['1', '2', '3'],
  );
  input.ledger[1] = created('2', `${P}S_p250_1317`, '2026-10-14', 'old'); // other content: not ours
  p = planEnable(input);
  assert.deepEqual(p.missing, [`${P}S_p250_1317`]);
  assert.deepEqual([...ownedForSession(input.ledger, WED).keys()], ['1', '3']);
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

const deployRow = (id: string, session: string, action = 'enable', ok = true) =>
  JSON.stringify({ at: 'x', session, mode: 'enable', action, id, name: id, ok });

test('a kept copy enabled for the next session is that session, for disable and check alike', () => {
  // Tue 20:00: Wednesday's K (kept from last week) and N (new) were enabled at 16:55
  const TUE = '2026-10-27';
  const NEXT_WED = '2026-10-28';
  const ledger = [created('K', `${P}K`, WED), created('N', `${P}N`, NEXT_WED)];
  const algos = [algo('K', `${P}K`, { enabled: true }), algo('N', `${P}N`, { enabled: true })];
  const enabledFor = enabledSessions(
    parseDeployLedger([deployRow('K', NEXT_WED), deployRow('N', NEXT_WED)].join('\n')),
  );
  const evening = { nowSeconds: HM(20, 0), enabledFor };
  // an evening disable for today touches neither; for Wednesday, both
  assert.deepEqual(planDisable(TUE, TUE, ledger, algos, evening).disable, []);
  assert.deepEqual(
    planDisable(NEXT_WED, TUE, ledger, algos, evening).disable.map((t) => t.id),
    ['K', 'N'],
  );
  assert.deepEqual(staleEnabled(TUE, HM(20, 0), ledger, algos, enabledFor), []);
  // without the deploy ledger the kept copy would look a week old
  assert.equal(staleEnabled(TUE, HM(20, 0), ledger, algos).length, 1);
  // last week's enable of the same copy does not make it this week's
  const old = enabledSessions(parseDeployLedger(deployRow('K', WED)));
  assert.equal(staleEnabled(TUE, HM(20, 0), ledger, algos, old).length, 1);
  // a failed enable does not count
  const failed = enabledSessions(parseDeployLedger(deployRow('K', NEXT_WED, 'enable', false)));
  assert.equal(failed.size, 0);
});

test('unreadable ledger lines are skipped, never a crash', () => {
  const rows = parseDeployLedger(
    ['null', '7', '"x"', '{"id":1}', deployRow('1', WED), '{"torn'].join('\n'),
  );
  assert.equal(rows.length, 1);
  assert.deepEqual([...toggledIds(rows, WED).keys()], ['1']);
  const ledger = parseQLedger(['null', '[]', JSON.stringify(created('1', `${P}A`))].join('\n'));
  assert.deepEqual(
    ledger.map((r) => r.id),
    ['1'],
  );
});

test("an enable that failed earlier this session is said so, and alerted, never 'switched off since'", () => {
  const toggled = toggledIds(parseDeployLedger(deployRow('1', WED, 'enable', false)), WED);
  const p = planEnable(wednesday({ toggled }));
  assert.deepEqual(p.enableFailed, [`${P}S_ditm1_1202`]);
  assert.deepEqual(p.leftOff, []);
  assert.ok(!p.enable.some((t) => t.id === '1'));
  const s = summaryEnable(p);
  assert.equal(s.attention, true);
  assert.ok(s.lines.some((l) => l.includes('ENABLE FAILED')));
  // a successful enable the owner switched off since: left off, no alert
  const off = planEnable(
    wednesday({ toggled: toggledIds(parseDeployLedger(deployRow('1', WED)), WED) }),
  );
  assert.deepEqual(off.leftOff, [`${P}S_ditm1_1202`]);
  assert.equal(summaryEnable(off).attention, false);
});

test("a stop's square-off row keeps the algo off for that session, like a disable (BL-143)", () => {
  const toggled = toggledIds(parseDeployLedger(deployRow('1', WED, 'sqoff')), WED);
  assert.deepEqual([...toggled.keys()], ['1']);
  const p = planEnable(wednesday({ toggled }));
  assert.deepEqual(p.leftOff, [`${P}S_ditm1_1202`]);
  assert.ok(!p.enable.some((t) => t.id === '1'));
});

describe('clientwise MTM SL (BL-172)', () => {
  const brokers = (days: Record<string, unknown>) => ({
    status: 'success',
    data: [
      { id: 'other', clientId: 'X', configurations: {} },
      { id: 'b1', clientId: 'R1', configurations: days },
    ],
  });
  const all = (sl: number, extra: Record<string, unknown> = {}) =>
    Object.fromEntries(
      ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((d) => [
        d,
        { stoploss: sl, target: 0, status: 'x', ...extra },
      ]),
    );

  it('reads the account by its broker id, every weekday', () => {
    const days = parseClientwise(brokers(all(-8000)), 'b1');
    assert.equal(days.SUN?.stoploss, -8000);
    assert.equal(clientwiseHolds(days, 8000), true);
    assert.equal(clientwiseNow(days), '₹8,000');
    assert.equal(clientwiseBody(days, 8000), null);
    assert.throws(() => parseClientwise(brokers(all(-8000)), 'nope'), /not in the brokers list/);
  });

  it('a different or partly different figure is set, keeping the target and trail', () => {
    const mixed = all(-9000, {
      target: 5000,
      trailingStoploss: { moveBy: 1000, trailBy: 500 },
      trailingInterval: 'MINUTE',
    });
    (mixed.WED as Record<string, unknown>).stoploss = -8000;
    const days = parseClientwise(brokers(mixed), 'b1');
    assert.equal(clientwiseHolds(days, 9000), false);
    assert.equal(clientwiseNow(days), 'differs by weekday');
    assert.deepEqual(clientwiseBody(days, 9000), {
      stoploss: -9000,
      target: 5000,
      trailingStoploss: { moveBy: 1000, trailBy: 500 },
      trailingInterval: 'MINUTE',
    });
  });

  it('none set reads as none and is sent with target 0', () => {
    const days = parseClientwise(brokers({}), 'b1');
    assert.equal(clientwiseNow(days), 'none');
    assert.deepEqual(clientwiseBody(days, 8000), { stoploss: -8000, target: 0 });
  });
});
