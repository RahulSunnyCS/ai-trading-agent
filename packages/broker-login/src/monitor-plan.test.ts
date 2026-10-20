import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { type Browser, chromium } from 'playwright';
import { parseLive } from './deploy-plan.js';
import {
  JOBS_WAIT_UNTIL,
  LOSS_ALERT_INR,
  LOSS_WARNING_INR,
  type LoginContext,
  type LoginLog,
  type MtmCard,
  type MtmNoticeState,
  PLATFORM_JOBS,
  PNL_STALE_MS,
  type QListed,
  READABLE_AGAIN_AFTER,
  type SchedulerJobView,
  UNREADABLE_NOTICES_A_DAY,
  algotestInstant,
  checkAlgoTest,
  checkQuantiply,
  commitMtmNotice,
  deployMessage,
  inLossWindow,
  inQuietWindow,
  inr,
  istDayOf,
  jobsStillToEnd,
  legLots,
  legsFromAlgtst,
  legsFromQuantiply,
  loginRefusal,
  lossCrossings,
  lossMessage,
  marginMessage,
  marginVerdict,
  mergeLogins,
  mtmNotice,
  mtmNoticeText,
  parseAlgotestBrokers,
  parseDayWiseListed,
  parseDeployedOn,
  parseMarginCsv,
  parseRupees,
  pickNeed,
  pnlFromSocketFrame,
  quantiplyReading,
  readMtmCardsInPage,
  readTotalMtm,
  stopButtonRunning,
  switchOn,
} from './monitor-plan.js';

const row = (name: string, deployed: number) =>
  `${name}\n\nNIFTY\n\n•\nINTRADAY\n\nReady to deploy\n\n${deployed} Deployed\n\n-\n-\n-\n-\n-\n-\n-\n\n`;

const liveText = (brokers: string, cards: string, rows: string) =>
  `Broker Login ${brokers}\n2/6 Strategy Deployed\nDeployed Strategies\nRunning\n${cards}\nActivation\n\n${rows}`;

const card = (name: string, broker: string) =>
  `Deployed on 21 OCT 26\nIntraday\n${name}\nNIFTY\nOpen Pos: 2\nRUNNING\n₹ 120\n${broker}\n`;

test('switches are on only when exactly "on"', () => {
  assert.equal(switchOn({ LOSS_ALERTS: ' On ' }, 'LOSS_ALERTS'), true);
  assert.equal(switchOn({ LOSS_ALERTS: 'yes' }, 'LOSS_ALERTS'), false);
  assert.equal(switchOn({}, 'LOSS_ALERTS'), false);
});

test('the quiet window 09:10-09:25 and the loss window 09:25-15:30', () => {
  assert.equal(inQuietWindow(9 * 60 + 9), false);
  assert.equal(inQuietWindow(9 * 60 + 10), true);
  assert.equal(inQuietWindow(9 * 60 + 24), true);
  assert.equal(inQuietWindow(9 * 60 + 25), false);
  assert.equal(inLossWindow(9 * 60 + 24), false);
  assert.equal(inLossWindow(9 * 60 + 25), true);
  assert.equal(inLossWindow(15 * 60 + 30), false);
});

test('logins: never in the quiet window, a cap, a backoff after a failure, a 30-minute replace', () => {
  const now = Date.parse('2026-10-21T05:00:00Z'); // 10:30 IST
  const at = (ms: number) => new Date(now - ms).toISOString();
  const m = 10 * 60 + 30;
  const r = (log: LoginLog, replacing = false, extra: Partial<LoginContext> = {}) =>
    loginRefusal({ log, cap: 3, minutes: m, nowMs: now, replacing, ...extra });
  assert.match(r({ count: 0 }, false, { minutes: 9 * 60 + 16 }) ?? '', /09:10 and 09:25/);
  assert.equal(r({ count: 2 }), null);
  assert.match(r({ count: 3 }) ?? '', /3 logins today/);
  assert.match(r({ count: 1, failedAt: at(5 * 60_000) }) ?? '', /failed/);
  assert.equal(r({ count: 1, failedAt: at(11 * 60_000) }), null);
  assert.match(r({ count: 1, reloginAt: at(20 * 60_000) }, true) ?? '', /30 minutes/);
  assert.equal(r({ count: 1, reloginAt: at(31 * 60_000) }, true), null);
});

test('logins (B): even the first replacement waits 10 minutes after the loss, and for other logins', () => {
  const now = Date.parse('2026-10-21T07:30:00Z'); // 13:00 IST
  const at = (ms: number) => new Date(now - ms).toISOString();
  const r = (log: LoginLog, replacing: boolean, extra: Partial<LoginContext> = {}) =>
    loginRefusal({ log, cap: 3, minutes: 13 * 60, nowMs: now, replacing, ...extra });
  // the first replacement has no reloginAt: the loss itself starts the wait
  assert.match(r({ count: 1, lostAt: at(3 * 60_000) }, true) ?? '', /ended less than 10 minutes/);
  assert.equal(r({ count: 1, lostAt: at(11 * 60_000) }, true), null);
  // a restarted monitor (not "replacing" in memory) still honours the loss on disk
  assert.match(r({ count: 1, lostAt: at(3 * 60_000) }, false) ?? '', /ended less than 10/);
  // another process logged in recently (the owner's tool run, the stop button): no replacement
  const lost = { count: 1, lostAt: at(15 * 60_000) };
  assert.match(
    r(lost, true, { otherLoginAtMs: now - 4 * 60_000 }) ?? '',
    /another login to this platform/,
  );
  assert.equal(r(lost, true, { otherLoginAtMs: now - 12 * 60_000 }), null);
  // ... but a first login of the day is not held by the morning jobs' logins (A covers those)
  assert.equal(r({ count: 0 }, false, { otherLoginAtMs: now - 60_000 }), null);
  // the stop button running: no login of any kind
  assert.match(r({ count: 0 }, false, { stopRunning: true }) ?? '', /stop button/);
});

test('logins (E): a --print run and the monitor merge their counts, never overwrite', () => {
  const merged = mergeLogins<string>(
    { algotest: { count: 3, failedAt: '2026-10-21T05:00:00.000Z' } },
    {
      algotest: { count: 2, failedAt: '2026-10-21T04:00:00.000Z', lostAt: '2026-10-21T06:00:00Z' },
      'quantiply-angelone': { count: 1 },
    },
  );
  assert.deepEqual(merged, {
    algotest: { count: 3, failedAt: '2026-10-21T05:00:00.000Z', lostAt: '2026-10-21T06:00:00Z' },
    'quantiply-angelone': { count: 1 },
  });
  assert.deepEqual(mergeLogins(undefined, undefined), {});
});

test("waiting for the morning's deploy jobs (A): running, due, queued, done, not today", () => {
  const now = new Date('2026-10-21T03:55:00Z'); // 09:25 IST
  const slot = (hhmm: string) => new Date(`2026-10-21T${hhmm}:00+05:30`).toISOString();
  const tomorrow = (hhmm: string) => new Date(`2026-10-22T${hhmm}:00+05:30`).toISOString();
  const done = { started_at: slot('09:18'), ended_at: slot('09:20') };
  const views: SchedulerJobView[] = [
    // the top-up's retry is still running
    {
      id: 'algotest-topup',
      nextRun: tomorrow('09:18'),
      lastRun: { started_at: slot('09:18'), ended_at: null },
      previousSlot: slot('09:18'),
      previousSlotRun: { ended_at: null },
    },
    // ended
    {
      id: 'algotest-deploy',
      nextRun: tomorrow('09:16'),
      lastRun: done,
      previousSlot: slot('09:16'),
      previousSlotRun: { ended_at: slot('09:17') },
    },
    // queued behind quantiply-topup in its group: its slot came, no row yet
    {
      id: 'quantiply-deploy-topup',
      nextRun: tomorrow('09:21'),
      lastRun: { started_at: '2026-10-20T03:51:00Z', ended_at: '2026-10-20T03:52:00Z' },
      previousSlot: slot('09:21'),
      previousSlotRun: null,
    },
  ];
  assert.deepEqual(jobsStillToEnd(views, PLATFORM_JOBS.algotest, now), [
    'algotest-topup is running (since 09:18)',
  ]);
  assert.deepEqual(jobsStillToEnd(views, PLATFORM_JOBS.quantiply, now), [
    'quantiply-deploy-topup is due (its 09:21 run has not started)',
  ]);
  // not scheduled today (yesterday's slot, a holiday-like gap) and not listed: nothing blocks
  const notToday: SchedulerJobView[] = [
    {
      id: 'quantiply-topup',
      nextRun: tomorrow('09:19'),
      lastRun: { started_at: '2026-10-20T03:49:00Z', ended_at: '2026-10-20T03:50:00Z' },
      previousSlot: '2026-10-20T03:49:00.000Z',
      previousSlotRun: { ended_at: '2026-10-20T03:50:00Z' },
    },
  ];
  assert.deepEqual(jobsStillToEnd(notToday, PLATFORM_JOBS.quantiply, now), []);
  // a slot later today, before the cap, still blocks (a --now run before 09:16)
  const early = new Date('2026-10-21T03:42:00Z'); // 09:12 IST
  const later: SchedulerJobView[] = [
    {
      id: 'algotest-deploy',
      nextRun: slot('09:16'),
      lastRun: null,
      previousSlot: '2026-10-20T03:46:00.000Z',
      previousSlotRun: { ended_at: '2026-10-20T03:47:00Z' },
    },
  ];
  assert.deepEqual(jobsStillToEnd(later, PLATFORM_JOBS.algotest, early), [
    'algotest-deploy runs at 09:16',
  ]);
  // ... but not one after the cap
  assert.deepEqual(jobsStillToEnd(later, PLATFORM_JOBS.algotest, early, 9 * 60 + 15), []);
  assert.equal(JOBS_WAIT_UNTIL, 10 * 60);
});

test("the stop button's running marker (B): alive and fresh only; a torn file by its age", () => {
  const now = Date.parse('2026-10-21T07:30:00Z');
  const alive = () => true;
  const dead = () => false;
  assert.equal(stopButtonRunning(null, null, now, alive), false);
  assert.equal(
    stopButtonRunning({ pid: 1, at: new Date(now - 60_000).toISOString() }, null, now, alive),
    true,
  );
  assert.equal(stopButtonRunning({ pid: 1, at: now - 60_000 }, null, now, alive), true);
  assert.equal(stopButtonRunning({ pid: 1, at: now - 60_000 }, null, now, dead), false);
  assert.equal(stopButtonRunning({ pid: 1, at: now - 11 * 60_000 }, null, now, alive), false);
  assert.equal(stopButtonRunning('unreadable', now - 5_000, now, alive), true);
  assert.equal(stopButtonRunning('unreadable', now - 11 * 60_000, now, alive), false);
  assert.equal(stopButtonRunning({ at: now - 5_000 }, null, now, dead), true); // no pid: by age
});

test('"cannot read" (C): said once, re-armed after 3 readings in a row, at most 3 a day', () => {
  const s: MtmNoticeState = { unreadable: {}, readableRun: {}, unreadableSaid: {} };
  const step = (readable: boolean, sent = true) => {
    const n = mtmNotice(s, 'Quantiply Angel One', readable);
    if (n && sent) commitMtmNotice(s, 'Quantiply Angel One', n);
    return n;
  };
  assert.equal(step(true), null); // readable from the start: nothing to say
  assert.equal(step(false, false), 'unreadable'); // Telegram did not take it: said again next
  assert.equal(step(false), 'unreadable');
  assert.equal(step(false), null); // said once
  assert.equal(step(true), null);
  assert.equal(step(false), null); // the run of good readings starts again
  assert.equal(step(true), null);
  assert.equal(step(true), null);
  assert.equal(step(true), 'readable-again');
  assert.equal(step(true), null);
  assert.equal(step(false), 'unreadable'); // a later loss of the feed is announced (2nd)
  for (let i = 0; i < READABLE_AGAIN_AFTER; i += 1) step(true);
  assert.match(
    mtmNoticeText(s, 'Quantiply Angel One', 'unreadable', '13:00'),
    /said 3 times today: not said again today/,
  );
  assert.equal(step(false), 'unreadable'); // 3rd
  for (let i = 0; i < READABLE_AGAIN_AFTER; i += 1) step(true);
  assert.equal(step(false), null); // the day's notices are used up
  assert.equal(UNREADABLE_NOTICES_A_DAY, 3);
  assert.match(
    mtmNoticeText(s, 'AlgoTest', 'readable-again', '13:05'),
    /AlgoTest's MTM reads again/,
  );
});

test('rupee figures: the whole text must be one amount', () => {
  assert.equal(parseRupees('₹ 0'), 0);
  assert.equal(parseRupees('₹ -1,23,456.50'), -123456.5);
  assert.equal(parseRupees('-₹ 5,234'), -5234);
  assert.equal(parseRupees('− ₹12'), -12);
  assert.equal(parseRupees('—'), null);
  assert.equal(parseRupees('₹ 12 Available ₹ 5'), null);
  assert.equal(inr(-5234.4), '₹-5,234');
  assert.equal(inr(1250073.78), '₹12,50,074');
});

test('Total MTM: the labelled card only; red is a loss; anything unclear is unread', () => {
  const c = (over: Partial<MtmCard>): MtmCard => ({
    label: 'Total MTM',
    value: '₹ 0',
    red: false,
    green: true,
    ...over,
  });
  assert.deepEqual(readTotalMtm([c({})]), { inr: 0 });
  assert.deepEqual(readTotalMtm([c({ value: '₹ 6,512.25', red: true, green: false })]), {
    inr: -6512.25,
  });
  assert.deepEqual(readTotalMtm([c({ value: '₹ -6,512', red: true, green: false })]), {
    inr: -6512,
  });
  assert.ok('error' in readTotalMtm([]));
  assert.ok('error' in readTotalMtm([c({}), c({})]));
  assert.ok('error' in readTotalMtm([c({ value: null })]));
  assert.ok('error' in readTotalMtm([c({ value: '-' })]));
  assert.ok('error' in readTotalMtm([c({ red: false, green: false })]));
  assert.ok('error' in readTotalMtm([c({ value: '₹ -10', green: true })]));
  // a broker card is never the total
  assert.ok('error' in readTotalMtm([c({ label: 'Finvasia - FA0000' })]));
});

let browser: Browser | null = null;
before(async () => {
  browser = await chromium.launch({ headless: true }).catch(() => null);
});
after(async () => {
  await browser?.close();
});

test('Total MTM read in a page from the card markup, never the margin figures', async (t) => {
  if (!browser) return t.skip('no Chromium available');
  const page = await browser.newPage();
  await page.setContent(readFileSync(new URL('./fixtures/live-mtm.html', import.meta.url), 'utf8'));
  const cards = await page.evaluate(readMtmCardsInPage);
  assert.equal(cards.length, 2);
  assert.deepEqual(readTotalMtm(cards), { inr: -6512.25 });
  await page.close();
});

test("AlgoTest's broker funds: available, the UTC stamps, deleted brokers left out", () => {
  const brokers = parseAlgotestBrokers({
    brokers: [
      {
        broker: 'Broker.Finvasia',
        deleted: false,
        logged_until: '2026-10-19T10:10:00.000',
        margin: { available: 1250073.78, updated_ts: '2026-10-19T02:47:39.300' },
        app_keys: { ApiKey: 'never-read' },
      },
      { broker: 'Broker.Old', deleted: true, margin: { available: 1 } },
      { broker: 'Broker.AngelOne', margin: {} },
    ],
  });
  assert.deepEqual(
    brokers.map((b) => [b.broker, b.available]),
    [
      ['Broker.Finvasia', 1250073.78],
      ['Broker.AngelOne', null],
    ],
  );
  assert.ok(!JSON.stringify(brokers).includes('never-read'));
  const at = algotestInstant(brokers[0]?.updatedAt ?? null);
  assert.equal(at?.toISOString(), '2026-10-19T02:47:39.300Z');
  assert.equal(istDayOf(at as Date), '2026-10-19'); // 08:17 IST
  assert.throws(() => parseAlgotestBrokers({}), /no brokers list/);
});

test('margin need: half a straddle per sold leg-lot; a bought leg by premium x lot, else not estimated', () => {
  const per = parseMarginCsv(
    'underlying,strategy_type,month,margin_inr\nNIFTY,short-straddle,2026-07,120000\nNIFTY,short-straddle,2026-08,140000\n',
  );
  assert.equal(per.get('NIFTY'), 140000);
  const lot = (u: string) => (u === 'NIFTY' ? 65 : u === 'SENSEX' ? 20 : null);
  const sold = legsFromAlgtst({
    strategy: {
      Ticker: 'SENSEX',
      ListOfLegConfigs: [
        { PositionType: 'PositionType.Sell', LotConfig: { Value: 1 } },
        {
          PositionType: 'PositionType.Sell',
          LotConfig: { Value: 2 },
          EntryType: 'EntryType.EntryByPremium',
          StrikeParameter: 250,
        },
      ],
    },
  });
  assert.deepEqual(sold[1], { underlying: 'SENSEX', sell: true, lots: 2, premium: 250 });
  assert.deepEqual(pickNeed('x', sold, per, lot), {
    name: 'x',
    inr: 210000,
    borrowed: ['SENSEX'],
    unestimated: false,
  });
  const byPremium = legsFromQuantiply({
    configurations: {
      legs: [
        {
          base: 'NIFTY',
          transactionType: 'B',
          quantity: 2,
          selectionType: 'PREMIUM',
          premium: { value: 100 },
        },
      ],
    },
  });
  assert.equal(pickNeed('b', byPremium, per, lot).inr, 100 * 65 * 2);
  const byStrike = legsFromQuantiply({
    configurations: {
      legs: [{ base: 'NIFTY', transactionType: 'B', quantity: 1, selectionType: 'STRIKE' }],
    },
  });
  assert.equal(pickNeed('s', byStrike, per, lot).unestimated, true);
});

test('margin verdict and message: a 20% cushion, short, unknown, not estimated', () => {
  assert.equal(marginVerdict(130, 100), 'ok');
  assert.equal(marginVerdict(110, 100), 'tight');
  assert.equal(marginVerdict(90, 100), 'short');
  assert.equal(marginVerdict(null, 100), 'unknown');
  const m = marginMessage('2026-10-21', [
    {
      account: 'Finvasia',
      uses: ['AlgoTest T1 preview'],
      picks: [{ name: 'a', inr: 140000, borrowed: ['SENSEX'], unestimated: false }],
      free: 100000,
      source: 'from AlgoTest',
    },
    {
      account: 'Angel One',
      uses: ['Quantiply Core'],
      picks: [],
      free: 500000,
      source: 's',
      picksMissing: true,
    },
    {
      account: 'X',
      uses: ['u'],
      picks: [{ name: 'buy', inr: 0, borrowed: [], unestimated: true }],
      free: 900000,
      source: 's',
    },
  ]);
  assert.equal(m.ok, false);
  assert.match(m.text, /❌ Finvasia .*SHORT by ₹40,000/);
  assert.match(m.text, /SENSEX estimated with NIFTY/);
  assert.match(m.text, /❔ Angel One .*need not known/);
  assert.match(m.text, /❔ X .*buy: bought by strike, premium not estimated/);
});

test('AlgoTest deploy check: per BL-140 row and broker, multiplier, missing, extra, the owner’s own', () => {
  const rows =
    row('T1 · A', 1) +
    row('T1 · B', 0) +
    row('T1 · C', 2) +
    row('T1 · X', 1) +
    row('Mine', 1) +
    row('T1 · D', 1) +
    row('T1 · F', 1);
  const text = liveText(
    '1/2',
    card('T1 · A', 'Finvasia - FA0000') +
      card('T1 · D', 'Finvasia - FA0000') +
      card('T1 · F', 'Angel One - R1'),
    rows,
  );
  const picks = ['T1 · A', 'T1 · B', 'T1 · C', 'T1 · D', 'T1 · E', 'T1 · F'];
  const c = checkAlgoTest(
    'AlgoTest T1',
    [{ broker: 'finvasia', picks }],
    parseLive(text),
    new Map([
      ['T1 · A', 1],
      ['T1 · D', 2],
      ['T1 · F', 1],
    ]),
    parseDeployedOn(text, picks),
  );
  assert.deepEqual(c.good, ['T1 · A']);
  assert.deepEqual(c.problems, [
    'T1 · B: not deployed',
    'T1 · C: deployed 2 times, expected 1',
    'T1 · D: multiplier 2, not 1',
    'T1 · E: not in AlgoTest',
    'T1 · F: not deployed on finvasia',
  ]);
  assert.deepEqual(c.extra, ['T1 · X (1 Deployed)']);
  assert.ok(c.notes.includes("also deployed (not the tool's): Mine"));
});

test('AlgoTest: a pick in both rows is two deploys; unread multipliers and brokers are said', () => {
  const text = liveText('2/2', '', row('T1 · A', 2));
  const c = checkAlgoTest(
    'AlgoTest T1',
    [
      { broker: 'finvasia', picks: ['T1 · A'] },
      { broker: 'angelone', picks: ['T1 · A'] },
    ],
    parseLive(text),
    new Map(),
    [],
  );
  assert.deepEqual(c.good, ['T1 · A']);
  assert.ok(c.notes.includes('multiplier not read for T1 · A'));
  assert.ok(c.notes.some((n) => n.includes('which broker')));
  const none = checkAlgoTest('AlgoTest T1', [], parseLive(liveText('0/2', '', '')), null, []);
  assert.match(none.problems[0] ?? '', /no broker logged in/);
  assert.ok(none.notes.includes('multipliers could not be read: deploy counts only'));
});

test('deployed cards: a cut name and the broker word', () => {
  const text = liveText('1/2', card('T1 · S_ditm1-t1s44...', 'Shoonya - FA1'), '');
  assert.deepEqual(parseDeployedOn(text, ['T1 · S_ditm1-t1s44_1102']), [
    { name: 'T1 · S_ditm1-t1s44_1102', broker: 'finvasia' },
  ]);
});

const q = (name: string, day: string, enabled: boolean, extra: Partial<QListed> = {}): QListed => ({
  id: `${name}-${day}`,
  name,
  day,
  enabled,
  status: 'NOT_RUNNING',
  multiplier: 1,
  startTime: '09:17:00',
  endTime: '15:28:00',
  ...extra,
});

test('Quantiply deploy check: enabled once on the weekday at 1x with the export lots', () => {
  const algos = [
    q('Core · A', 'WED', true),
    q('Core · B', 'WED', false),
    q('Core · C', 'WED', true, { multiplier: 2 }),
    q('Core · D', 'WED', true),
    q('Core · E', 'TUE', true),
    q('Core · X', 'WED', true),
    q('N_ITM1_SL21_3000', 'WED', true),
  ];
  const c = checkQuantiply(
    'Quantiply Core',
    ['A', 'B', 'C', 'D', 'E'].map((x) => ({ name: `Core · ${x}`, lots: [1, 1] })),
    algos,
    'WED',
    new Map([
      ['Core · A-WED', [1, 1]],
      ['Core · D-WED', [2, 2]],
    ]),
  );
  assert.deepEqual(c.good, ['Core · A']);
  assert.deepEqual(c.problems, [
    'Core · B: not enabled',
    'Core · C: multiplier 2, not 1',
    'Core · D: lots 2/2, the export says 1/1',
    'Core · E: not in Quantiply for WED',
  ]);
  assert.deepEqual(c.extra, ['Core · X (enabled)']);
  assert.deepEqual(c.notes, ["also enabled for WED (not the tool's): N_ITM1_SL21_3000"]);
});

test('the deploy message: one headline with the time it ran, then what is wrong', () => {
  const ok = deployMessage('2026-10-21', '09:25', [
    {
      label: 'AlgoTest T1',
      expected: 3,
      good: ['a', 'b', 'c'],
      problems: [],
      extra: [],
      notes: [],
    },
    {
      label: 'Quantiply Core',
      expected: 3,
      good: ['a', 'b', 'c'],
      problems: [],
      extra: [],
      notes: [],
    },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.text.split('\n')[0], 'AlgoTest T1 3/3 · Quantiply Core 3/3 ✅');
  const bad = deployMessage('2026-10-21', '13:02', [
    {
      label: 'AlgoTest T1',
      expected: 3,
      good: ['a'],
      problems: ['b: not deployed'],
      extra: ['x'],
      notes: [],
    },
    {
      label: 'Quantiply Core',
      expected: 0,
      good: [],
      problems: [],
      extra: [],
      notes: [],
      error: 'login held',
    },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.text.split('\n')[0], 'AlgoTest T1 1/3 · Quantiply Core not read ⚠️');
  assert.match(bad.text, /Deploy check 2026-10-21 13:02/);
  assert.match(bad.text, /❌ Quantiply Core: login held/);
});

test('loss levels: each once a day; straight past the alert sends the alert alone', () => {
  assert.deepEqual(lossCrossings(-4999, { warned: false, alerted: false }), []);
  assert.deepEqual(lossCrossings(LOSS_WARNING_INR, { warned: false, alerted: false }), ['warning']);
  assert.deepEqual(lossCrossings(-6000, { warned: true, alerted: false }), []);
  assert.deepEqual(lossCrossings(LOSS_ALERT_INR, { warned: true, alerted: false }), ['alert']);
  assert.deepEqual(lossCrossings(-9000, { warned: false, alerted: false }), ['alert']);
  assert.deepEqual(lossCrossings(-9000, { warned: true, alerted: true }), []);
  const text = lossMessage(
    'alert',
    -8100,
    [
      { label: 'AlgoTest', inr: -5000 },
      { label: 'Quantiply Angel One', inr: null },
    ],
    '11:42',
  );
  assert.match(text, /LOSS ALERT 11:42: the tool's platforms are at ₹-8,100/);
  assert.match(text, /Quantiply Angel One: cannot read/);
  assert.match(text, /trades placed elsewhere are not counted/);
  assert.match(text, /nothing was squared off/);
});

test("Quantiply's socket frames: the CSV algo update in a socket.io packet", () => {
  const id = '6ad597a2892783f88a7e4ce5';
  assert.deepEqual(pnlFromSocketFrame(`42["message","${id},,,,-1520.5,false:0:0,,false,false"]`), [
    { id, pnl: -1520.5 },
  ]);
  assert.deepEqual(pnlFromSocketFrame(`42["message",{"data":"${id},a,b,c,310"}]`), [
    { id, pnl: 310 },
  ]);
  assert.deepEqual(pnlFromSocketFrame('3'), []);
  assert.deepEqual(pnlFromSocketFrame('42["message","NIFTY,NSE,1729,25010.5"]'), []);
  assert.deepEqual(pnlFromSocketFrame(`42["message","${id},,,,"]`), []);
});

test("Quantiply's MTM: waiting = 0, running needs a fresh figure, closed needs one, else cannot read", () => {
  const now = Date.parse('2026-10-21T05:00:00Z');
  const s = (hms: string) => {
    const [h, m] = hms.split(':').map(Number);
    return (h ?? 0) * 3600 + (m ?? 0) * 60;
  };
  const algos = [
    q('Core · A', 'WED', true, { id: 'a', status: 'SOME_RUNNING_STATE' }),
    q('Core · B', 'WED', true, { id: 'b', status: 'TRADE_CLOSED' }),
    q('Core · W', 'WED', true, { id: 'w', startTime: '13:17:00' }),
    q('Core · D', 'TUE', true, { id: 'd' }),
    q('Mine off', 'WED', false, { id: 'o' }),
  ];
  const fresh = { a: { pnl: -1000, at: now - 60_000 }, b: { pnl: 250, at: now - 3_600_000 } };
  assert.deepEqual(quantiplyReading(algos, 'WED', fresh, now, s('10:30')), {
    inr: -750,
    unread: [],
  });
  // a stale running figure, whatever the status is called
  const stale = { ...fresh, a: { pnl: -1000, at: now - PNL_STALE_MS - 1 } };
  assert.deepEqual(quantiplyReading(algos, 'WED', stale, now, s('10:30')), {
    inr: null,
    unread: ['Core · A'],
  });
  // a closed algo with no figure is unread, not 0
  assert.deepEqual(quantiplyReading(algos, 'WED', { a: fresh.a }, now, s('10:30')).unread, [
    'Core · B',
  ]);
  // past its start, an enabled NOT_RUNNING algo needs a figure
  assert.deepEqual(quantiplyReading(algos, 'WED', fresh, now, s('13:30')).unread, ['Core · W']);
});

test('the day-wise list keeps multiplier and times; leg lots of an algo', () => {
  const listed = parseDayWiseListed({
    data: [
      {
        day: 'WED',
        algos: [
          {
            _id: 'x',
            name: 'Core · A',
            day: 'WED',
            enabled: true,
            status: 'NOT_RUNNING',
            multiplier: 1,
            startTime: '09:17:00',
            endTime: '15:28:00',
          },
        ],
      },
      { day: 'THU', algos: [] },
    ],
  });
  assert.deepEqual(listed, [
    {
      id: 'x',
      name: 'Core · A',
      day: 'WED',
      enabled: true,
      status: 'NOT_RUNNING',
      multiplier: 1,
      startTime: '09:17:00',
      endTime: '15:28:00',
    },
  ]);
  assert.deepEqual(
    legLots({ configurations: { legs: [{ quantity: 1 }, { quantity: 2 }] } }),
    [1, 2],
  );
});
