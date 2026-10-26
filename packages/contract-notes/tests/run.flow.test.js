const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../run');
const { readCursors, readDay } = require('../store');

// The whole run against a fake mailbox: the mail, the PDF reader and the clock are injected.
// A message's attachment content stands for the note: a number is its obligation, 'bad' a
// note that will not read.

const MON_NIGHT = new Date('2026-10-26T18:31:00Z'); // Tue 27 Oct 00:01 IST: last session Mon 26
const TUE_NIGHT = new Date('2026-10-27T18:31:00Z'); // Wed 28 Oct 00:01 IST: last session Tue 27

let dir;
let mail;
let reachable;
let errors;

function account(broker, accountId) {
  return { broker, accountId, pdfPassword: 'p' };
}

function deps(now, accounts = [account('finvasia', 'FA1')]) {
  return {
    env: {
      TRADING_DATA_ROOT: dir,
      BROKER_ACCOUNTS_JSON: JSON.stringify([{ email: 'm@x.com', emailPassword: 'pw', accounts }]),
    },
    hasQpdf: () => true,
    connect: async () => {
      if (!reachable) throw new Error('connection refused');
      return { imap: { end() {} }, uidvalidity: '7' };
    },
    searchNotes: async (_imap, _subject, { afterUid, overlapSince }) =>
      mail.filter(
        (m) =>
          afterUid == null || m.uid > afterUid || String(m.received).slice(0, 10) >= overlapSince,
      ),
    readNote: async (file) => {
      const body = fs.readFileSync(file, 'utf8');
      if (body === 'bad') return { error: 'parse failed' };
      return {
        extracted: { payin_payout_obligation: Number(body), net_brokerage: 10, other_charges: 5 },
      };
    },
    now: () => now,
    log: () => {},
  };
}

/** A Finvasia note mail for 'YYYY-MM-DD'. */
function finvasia(uid, day, body, received = `${day}T15:00:00Z`) {
  const [y, m, d] = day.split('-');
  return {
    uid,
    subject: `Combined Contract Note for FA1 ${d}-${m}-${y}`,
    received,
    attachments: [{ filename: 'note.pdf', content: Buffer.from(String(body)) }],
  };
}

const root = () => path.join(fs.realpathSync(dir), 'contract-notes');
const line = (day, account = 'FA1') => readDay(root(), day).find((l) => l.account === account);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-flow-'));
  mail = [];
  reachable = true;
  errors = [];
  jest.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stores each note, closes the sessions before it as no trade, and sets the bookmark', async () => {
  mail = [finvasia(101, '2026-10-22', 500), finvasia(102, '2026-10-26', 700)];
  expect(await main([], deps(MON_NIGHT))).toBe(0);

  expect(line('2026-10-22').fno.final_net).toBe(485);
  expect(line('2026-10-26').status).toBe('note');
  expect(line('2026-10-21').status).toBe('no_trade');
  expect(line('2026-10-23').status).toBe('no_trade');
  expect(readCursors(root())['m@x.com|finvasia/FA1'].last_uid).toBe(102);
});

test('a second run with no new mail rewrites nothing', async () => {
  mail = [finvasia(101, '2026-10-26', 700)];
  await main([], deps(MON_NIGHT));
  const before = fs.readFileSync(path.join(root(), 'days', '2026-10-26.jsonl'), 'utf8');
  expect(await main([], deps(MON_NIGHT))).toBe(0);
  expect(fs.readFileSync(path.join(root(), 'days', '2026-10-26.jsonl'), 'utf8')).toBe(before);
});

test('a note that fails stays open (never no trade), alerts every run, and --day fixes it', async () => {
  mail = [finvasia(101, '2026-10-22', 'bad'), finvasia(102, '2026-10-26', 700)];
  expect(await main([], deps(MON_NIGHT))).toBe(1);
  expect(line('2026-10-22').status).toBe('failed');
  expect(line('2026-10-21').status).toBe('no_trade');
  expect(errors.join('\n')).toMatch(/2026-10-22: parse failed/);

  errors = [];
  expect(await main([], deps(MON_NIGHT))).toBe(1); // behind the bookmark: still alerted
  expect(errors.join('\n')).toMatch(/2026-10-22: still not read — parse failed/);

  mail[0] = finvasia(101, '2026-10-22', 500); // the extractor is fixed
  expect(await main(['--day', '2026-10-22'], deps(MON_NIGHT))).toBe(0);
  expect(line('2026-10-22').status).toBe('note');
});

test('two different notes for one session: failed and alerted; --day takes the newest', async () => {
  mail = [
    finvasia(101, '2026-10-26', 700, '2026-10-26T15:00:00Z'),
    finvasia(102, '2026-10-26', 650, '2026-10-26T17:00:00Z'),
  ];
  expect(await main([], deps(MON_NIGHT))).toBe(1);
  expect(line('2026-10-26').status).toBe('failed');
  expect(errors.join('\n')).toMatch(/2 different notes/);

  expect(await main(['--day', '2026-10-26'], deps(MON_NIGHT))).toBe(0);
  const stored = line('2026-10-26');
  expect(stored.fno.payin_payout_obligation).toBe(650);
  expect(stored.superseded).toHaveLength(1);
});

test('a different note for a stored session is reported once and never written over', async () => {
  mail = [finvasia(101, '2026-10-26', 700)];
  await main([], deps(MON_NIGHT));
  mail.push(finvasia(102, '2026-10-26', 999));
  expect(await main([], deps(MON_NIGHT))).toBe(1);
  expect(errors.join('\n')).toMatch(/a second, different note/);
  expect(line('2026-10-26').fno.payin_payout_obligation).toBe(700);

  errors = [];
  expect(await main([], deps(MON_NIGHT))).toBe(0); // already reported: behind the bookmark now
});

test('a quiet account alerts on every run of the day its spell begins, then not again', async () => {
  expect(await main([], deps(MON_NIGHT))).toBe(1);
  expect(errors.join('\n')).toMatch(/no contract note in the last 10 sessions/);
  expect(line('2026-10-12').status).toBe('no_note');

  errors = [];
  expect(await main([], deps(MON_NIGHT))).toBe(1); // the retry: the alert is not swallowed

  errors = [];
  expect(await main([], deps(TUE_NIGHT))).toBe(0); // the next day
  expect(errors).toEqual([]);
});

test('mail that matches but has no readable note is reported, once', async () => {
  mail = [
    finvasia(101, '2026-10-26', 700),
    {
      uid: 102,
      subject: 'Combined Contract Note for FA1 (revised)',
      received: 'r',
      attachments: [],
    },
  ];
  expect(await main([], deps(MON_NIGHT))).toBe(1);
  expect(errors.join('\n')).toMatch(/no note could be read/);

  errors = [];
  expect(await main([], deps(MON_NIGHT))).toBe(0);
});

test("another account's note in a shared mailbox is not unreadable mail", async () => {
  const angel = (uid, id, day) => ({
    uid,
    subject: 'Contract Note - Equity Segment',
    received: 'r',
    attachments: [{ filename: `CN_${id}_${day}.pdf`, content: Buffer.from('100') }],
  });
  mail = [angel(101, 'R1', '26102026'), angel(102, 'R2', '26102026')];
  const both = [account('angelone', 'R1'), account('angelone', 'R2')];
  expect(await main([], deps(MON_NIGHT, both))).toBe(0);
  expect(line('2026-10-26', 'R1').status).toBe('note');
  expect(line('2026-10-26', 'R2').status).toBe('note');
});

test('an unreachable mailbox closes nothing for its accounts', async () => {
  reachable = false;
  expect(await main([], deps(MON_NIGHT))).toBe(1);
  expect(readDay(root(), '2026-10-12')).toEqual([]);
  expect(errors.join('\n')).toMatch(/connection refused/);
  expect(errors.join('\n')).not.toMatch(/no contract note/);
}, 30000);
