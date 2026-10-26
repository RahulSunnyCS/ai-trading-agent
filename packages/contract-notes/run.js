const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const pdfParse = require('pdf-parse');
const { getBroker, isSupported, loadBrokerAccounts } = require('./brokers');
const { addDays, lastSession, sessionsBack } = require('./calendar');
const { connect, decryptWithQpdf, hasQpdf, searchNotes } = require('./fetchMail');
const { closeWithoutNotes, key, noteLine, openPairs } = require('./record');
const {
  readCursors,
  readDay,
  readStatus,
  saveRaw,
  storeRoot,
  writeCursors,
  writeLine,
} = require('./store');
const { withRetry } = require('./utils/retry');

// The contract-notes run (BL-168). For each broker account it reads the mail that arrived
// since its bookmark (cursor.json: the last message read, per mailbox and account), keeps every
// note's PDF, reads its F&O figures and stores the session's line under
// TRADING_DATA_ROOT/contract-notes/. Then it closes the sessions of the window that can have no
// note (record.js). Scheduler jobs `contract-notes` (00:00) and `contract-notes-retry` (07:30).
//
//   node run.js                 new mail since each bookmark; the window is the last 10 sessions
//   node run.js --dry-run       read and parse, write nothing (not even the bookmark)
//   node run.js --day D         read session D again by date for every account, bookmark untouched
//   node run.js --sessions N    a wider window, e.g. after a long trip

const SESSIONS = 10;

function parseArgs(argv) {
  const opts = { dryRun: false, day: null, sessions: SESSIONS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--day') opts.day = argv[++i];
    else if (a === '--sessions') opts.sessions = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.day && !/^\d{4}-\d{2}-\d{2}$/.test(opts.day)) throw new Error('--day takes YYYY-MM-DD');
  if (!Number.isInteger(opts.sessions) || opts.sessions < 1) {
    throw new Error('--sessions takes a whole number of at least 1');
  }
  return opts;
}

/** An account as logs show it: enough to tell accounts apart, not the whole id. */
function label(acc) {
  const id = acc.accountId;
  return `${acc.broker} ${id.slice(0, 2)}··${id.slice(-2)}`;
}

const maskMailbox = (email) => `${email.slice(0, 2)}···@${email.split('@')[1] ?? ''}`;

/** Decrypt and read one note; returns { extracted } or { error }. */
async function readNote(file, acc, out) {
  const decrypted = decryptWithQpdf(file, acc.pdfPassword, out);
  if (decrypted.error) return { error: `decrypt: ${decrypted.error}` };
  const { text } = await pdfParse(fs.readFileSync(decrypted.path));
  const extracted = getBroker(acc.broker).extract(text);
  return extracted.error ? { error: extracted.error } : { extracted };
}

/** The notes in `messages` for this account, grouped by session: day -> [note]. */
function notesByDay(messages, acc) {
  const plugin = getBroker(acc.broker);
  const byDay = new Map();
  for (const msg of messages) {
    for (const att of msg.attachments) {
      const day = plugin.noteDay({
        subject: msg.subject,
        filename: att.filename,
        accountId: acc.accountId,
      });
      if (!day) continue;
      const sha256 = crypto.createHash('sha256').update(att.content).digest('hex');
      const notes = byDay.get(day) ?? [];
      if (!notes.some((n) => n.sha256 === sha256)) {
        notes.push({
          day,
          sha256,
          content: att.content,
          subject: msg.subject,
          received: msg.received,
          attachment: att.filename,
        });
      }
      byDay.set(day, notes);
    }
  }
  return byDay;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const config = loadBrokerAccounts();
  if (!hasQpdf()) throw new Error('qpdf is not on PATH — brew install qpdf');
  const root = storeRoot();
  const at = new Date().toISOString();

  const window = opts.day ? [opts.day] : sessionsBack(lastSession(), opts.sessions);
  const previous = opts.day ? null : sessionsBack(addDays(window[0], -1), 1)[0];
  const status = readStatus(root, previous ? [previous, ...window] : window);
  const cursors = readCursors(root);
  const problems = [];
  const accounts = [];

  console.log(
    `window ${window[0]} → ${window[window.length - 1]}${opts.dryRun ? ' (dry run: nothing is written)' : ''}`,
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-notes-'));
  try {
    for (const mailbox of config) {
      const mine = mailbox.accounts.filter((acc) => {
        if (isSupported(acc.broker)) return true;
        console.log(`skip  ${label(acc)}: no reader for "${acc.broker}" yet (BL-168 Phase 3)`);
        return false;
      });
      accounts.push(...mine);
      if (!mine.length) continue;

      let conn;
      try {
        conn = await withRetry(() => connect(mailbox), {
          attempts: 3,
          baseDelayMs: 3000,
          retryIf: (err) => !/Invalid credentials|AUTHENTICATIONFAILED/i.test(err.message),
          onRetry: (err, attempt) =>
            console.log(`mailbox ${maskMailbox(mailbox.email)}: retry ${attempt} (${err.message})`),
        });
      } catch (err) {
        problems.push(`mailbox ${maskMailbox(mailbox.email)}: ${err.message}`);
        continue;
      }

      try {
        for (const acc of mine) {
          const cursorKey = `${mailbox.email}|${acc.broker}/${acc.accountId}`;
          const cursor = cursors[cursorKey];
          const bookmark = !opts.day && cursor?.uidvalidity === conn.uidvalidity ? cursor : null;
          let messages;
          try {
            messages = await searchNotes(
              conn.imap,
              getBroker(acc.broker).searchSubject(acc.accountId),
              {
                sinceDay: addDays(window[0], -1),
                afterUid: bookmark ? bookmark.last_uid : null,
              },
            );
          } catch (err) {
            problems.push(`${label(acc)}: mailbox search failed: ${err.message}`);
            continue;
          }
          const failedBefore = problems.length;

          for (const [day, notes] of notesByDay(messages, acc)) {
            if (opts.day && day !== opts.day) continue;
            if (notes.length > 1) {
              problems.push(
                `${label(acc)} ${day}: ${notes.length} different notes — check them by hand`,
              );
              continue;
            }
            const note = notes[0];
            const existing =
              status.get(key(day, acc.broker, acc.accountId)) ??
              readDay(root, day).find(
                (l) => l.broker === acc.broker && l.account === acc.accountId,
              );
            if (!opts.day && existing?.status === 'note') {
              if (existing.note?.sha256 !== note.sha256) {
                problems.push(
                  `${label(acc)} ${day}: a second, different note arrived (${note.attachment}); the stored one is kept — compare them, then \`node run.js --day ${day}\``,
                );
              }
              continue;
            }

            let file;
            if (opts.dryRun) {
              file = path.join(scratch, `${acc.broker}-${day}.pdf`);
              fs.writeFileSync(file, note.content);
            } else {
              file = saveRaw(root, acc.broker, acc.accountId, day, note.content).file;
            }
            const read = await readNote(file, acc, file.replace(/\.pdf$/, '.decrypted.pdf'));
            if (read.error) {
              problems.push(
                `${label(acc)} ${day}: ${read.error} (${note.attachment}) — fix it, then \`node run.js --day ${day}\``,
              );
              continue;
            }
            const line = noteLine({
              day,
              broker: acc.broker,
              account: acc.accountId,
              extracted: read.extracted,
              note: { ...note, file: opts.dryRun ? null : path.relative(root, file) },
              at,
            });
            status.set(key(day, acc.broker, acc.accountId), line);
            if (!opts.dryRun) writeLine(root, line);
            const was = existing && existing.status !== 'note' ? ` (was ${existing.status})` : '';
            console.log(
              `note  ${day} ${label(acc)}: final net ${line.fno.final_net}, obligation ${line.fno.payin_payout_obligation}, charges ${line.fno.total_charges}${was}`,
            );
          }

          // Move the bookmark only when everything read was stored, so a failed note is read
          // again next run (and keeps alerting) until it is fixed.
          if (!opts.day && !opts.dryRun && problems.length === failedBefore) {
            const newest = messages.reduce((m, msg) => Math.max(m, msg.uid ?? 0), 0);
            cursors[cursorKey] = {
              uidvalidity: conn.uidvalidity,
              last_uid: Math.max(newest, bookmark?.last_uid ?? 0, conn.uidnext - 1),
              checked_at: at,
            };
          }
          console.log(
            `read  ${label(acc)}: ${messages.length} new message(s)${bookmark ? ` after #${bookmark.last_uid}` : ` since ${addDays(window[0], -1)}`}`,
          );
        }
      } finally {
        conn.imap.end();
      }
    }

    if (!opts.dryRun) writeCursors(root, cursors);

    if (!opts.day) {
      const { lines, newlyQuiet } = closeWithoutNotes(window, accounts, status, at, previous);
      for (const line of lines) {
        status.set(key(line.day, line.broker, line.account), line);
        if (!opts.dryRun) writeLine(root, line);
        console.log(
          `${line.status.padEnd(5)} ${line.day} ${label({ broker: line.broker, accountId: line.account })}: ${line.reason}`,
        );
      }
      for (const acc of newlyQuiet) {
        problems.push(
          `${label(acc)}: no contract note in the last ${window.length} sessions — is the account still trading, and is its note still mailed to this mailbox?`,
        );
      }
      const waiting = openPairs(window, accounts, status);
      console.log(
        `done: ${waiting.length} account-session(s) waiting for a note${waiting.length ? `: ${waiting.map((p) => `${p.day} ${label(p)}`).join(', ')}` : ''}`,
      );
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  if (problems.length) {
    console.error(`${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`contract-notes: ${err.message}`);
      process.exit(1);
    },
  );
}

module.exports = { main, parseArgs, notesByDay, label };
