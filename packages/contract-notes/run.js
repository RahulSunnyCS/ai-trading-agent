const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const pdfParse = require('pdf-parse');
const { getBroker, isSupported, loadBrokerAccounts } = require('./brokers');
const { addDays, istNow, lastSession, sessionsBack, sessionsBetween } = require('./calendar');
const { connect, decryptWithQpdf, hasQpdf, searchNotes } = require('./fetchMail');
const { closeWithoutNotes, failedLine, key, noteLine, openPairs } = require('./record');
const {
  acquireLock,
  readCursors,
  readDay,
  readStatus,
  saveRaw,
  storeRoot,
  writeCursors,
  writeLine,
} = require('./store');
const { withRetry } = require('./utils/retry');

// The contract-notes run (BL-168). For each broker account it reads the mail after its
// bookmark (cursor.json: the newest message read, per mailbox and account), keeps every note's
// PDF, reads its F&O figures and stores the session's line under
// TRADING_DATA_ROOT/contract-notes/. Then it closes the sessions of the window that can have no
// note (record.js). Scheduler jobs `contract-notes` (00:00) and `contract-notes-retry` (07:30).
//
//   node run.js                 new mail since each bookmark; the window is the last 10 sessions
//   node run.js --dry-run       read and parse, write nothing (not even the bookmark)
//   node run.js --day D         read session D again by date for every account; with two
//                               different notes for D, the newest received is taken
//   node run.js --sessions N    a wider window, e.g. after a long trip
//   node run.js --from D --to D history: every note received for sessions D..D, by date, the
//                               bookmark untouched; a stored note is never written over

const SESSIONS = 10;
// Each search also takes the mail of the last few days, whatever the bookmark: a note Gmail
// indexed late is still found, and a recent note that failed is tried again. Stored notes are
// skipped by hash. Days, not message numbers: one mailbox gets few mails, another thousands.
const OVERLAP_DAYS = 3;

function parseArgs(argv) {
  const opts = { dryRun: false, day: null, sessions: SESSIONS, from: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--day') opts.day = argv[++i];
    else if (a === '--sessions') opts.sessions = Number(argv[++i]);
    else if (a === '--from') opts.from = argv[++i];
    else if (a === '--to') opts.to = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (opts.day && !isDay(opts.day)) throw new Error('--day takes YYYY-MM-DD');
  if ((opts.from || opts.to) && !(isDay(opts.from) && isDay(opts.to) && opts.from <= opts.to)) {
    throw new Error('--from and --to go together, as YYYY-MM-DD, from first');
  }
  if (opts.day && opts.from) throw new Error('--day or --from/--to, not both');
  if (!Number.isInteger(opts.sessions) || opts.sessions < 1) {
    throw new Error('--sessions takes a whole number of at least 1');
  }
  return opts;
}

const mask = (id) => `${id.slice(0, 2)}··${id.slice(-2)}`;

/** An account as logs show it: enough to tell accounts apart, not the whole id. */
function label(acc) {
  return `${acc.broker} ${mask(acc.accountId)}`;
}

/** Any text with the account's id masked (attachment names carry it). */
const hideId = (text, acc) => String(text).split(acc.accountId).join(mask(acc.accountId));

const maskMailbox = (email) => `${email.slice(0, 2)}···@${email.split('@')[1] ?? ''}`;

/** Decrypt and read one note; returns { extracted } or { error }. Never throws. */
async function readNote(file, acc) {
  try {
    const decrypted = decryptWithQpdf(
      file,
      acc.pdfPassword,
      file.replace(/\.pdf$/, '.decrypted.pdf'),
    );
    if (decrypted.error) return { error: `decrypt: ${decrypted.error}` };
    const { text } = await pdfParse(fs.readFileSync(decrypted.path));
    const extracted = getBroker(acc.broker).extract(text);
    return extracted.error ? { error: extracted.error } : { extracted };
  } catch (err) {
    return { error: `read: ${err.message}` };
  }
}

/**
 * The notes in `messages` for this account, by session: { byDay: day -> [note], unread:
 * [message] }. `unread` holds messages that matched the search but carry no note this account
 * (or another account of the same broker in the mailbox, `siblings`) can be read from: a
 * changed subject or file name must be seen, not skipped.
 */
function notesByDay(messages, acc, siblings = []) {
  const plugin = getBroker(acc.broker);
  const byDay = new Map();
  const unread = [];
  for (const msg of messages) {
    let claimed = false;
    for (const att of msg.attachments) {
      const ask = (accountId) =>
        plugin.noteDay({ subject: msg.subject, filename: att.filename, accountId });
      const day = ask(acc.accountId);
      if (!day) {
        if (siblings.some((s) => ask(s.accountId))) claimed = true;
        continue;
      }
      claimed = true;
      const sha256 = crypto.createHash('sha256').update(att.content).digest('hex');
      const notes = byDay.get(day) ?? [];
      if (!notes.some((n) => n.sha256 === sha256)) {
        notes.push({
          day,
          sha256,
          uid: msg.uid,
          content: att.content,
          subject: msg.subject,
          received: msg.received,
          attachment: att.filename,
        });
      }
      byDay.set(day, notes);
    }
    if (!claimed) unread.push(msg);
  }
  return { byDay, unread };
}

async function main(argv, deps = {}) {
  const d = {
    connect,
    searchNotes,
    hasQpdf,
    readNote,
    lock: acquireLock,
    env: process.env,
    now: () => new Date(),
    log: (line) => console.log(line),
    ...deps,
  };
  const opts = parseArgs(argv);
  const config = loadBrokerAccounts(d.env.BROKER_ACCOUNTS_JSON);
  if (!d.hasQpdf()) throw new Error('qpdf is not on PATH — brew install qpdf');
  const root = storeRoot(d.env);
  const now = d.now();
  const at = now.toISOString();
  const today = istNow(now).day;

  // --day and --from/--to read by date and leave the bookmark alone.
  const history = Boolean(opts.from);
  const byDate = Boolean(opts.day) || history;
  const window = opts.day
    ? [opts.day]
    : history
      ? sessionsBetween(opts.from, opts.to)
      : sessionsBack(lastSession(now), opts.sessions);
  if (!window.length) throw new Error(`no trading day from ${opts.from} to ${opts.to}`);
  // One run at a time over the store: a history run must not overlap the nightly job.
  const release = d.lock(root);
  // A session's note can arrive days later (Angel One's after midnight, a revised note).
  const lateNotes = (day) => addDays(day, 5);
  const status = readStatus(root, window);
  const cursors = readCursors(root);
  const problems = [];
  const accounts = [];
  const unreachable = new Set();
  const touched = new Set(); // lines this run wrote
  const write = (line) => {
    status.set(key(line.day, line.broker, line.account), line);
    touched.add(key(line.day, line.broker, line.account));
    if (!opts.dryRun) writeLine(root, line);
  };
  const fail = (acc, day, reason) => {
    write(failedLine({ day, broker: acc.broker, account: acc.accountId, reason, at }));
    problems.push(`${label(acc)} ${day}: ${hideId(reason, acc)}`);
  };

  d.log(
    `window ${window[0]} → ${window[window.length - 1]}${opts.dryRun ? ' (dry run: nothing is written)' : ''}`,
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-notes-'));
  try {
    for (const mailbox of config) {
      const mine = mailbox.accounts.filter((acc) => {
        if (isSupported(acc.broker)) return true;
        d.log(`skip  ${label(acc)}: no reader for "${acc.broker}" yet (BL-168 Phase 3)`);
        return false;
      });
      accounts.push(...mine);
      if (!mine.length) continue;

      let conn;
      try {
        conn = await withRetry(() => d.connect(mailbox), {
          attempts: 3,
          baseDelayMs: 3000,
          retryIf: (err) => !/Invalid credentials|AUTHENTICATIONFAILED/i.test(err.message),
          onRetry: (err, attempt) =>
            d.log(`mailbox ${maskMailbox(mailbox.email)}: retry ${attempt} (${err.message})`),
        });
      } catch (err) {
        problems.push(`mailbox ${maskMailbox(mailbox.email)}: ${err.message}`);
        for (const acc of mine) unreachable.add(acc);
        continue;
      }

      try {
        for (const acc of mine) {
          const cursorKey = `${mailbox.email}|${acc.broker}/${acc.accountId}`;
          const cursor = cursors[cursorKey] ?? {};
          const bookmark =
            cursor.uidvalidity === conn.uidvalidity && Number.isInteger(cursor.last_uid)
              ? cursor.last_uid
              : null;
          let messages;
          try {
            messages = await d.searchNotes(
              conn.imap,
              getBroker(acc.broker).searchSubject(acc.accountId),
              {
                sinceDay: addDays(window[0], -1),
                // History stops a few days after its range; --day reads to now (a revised note
                // can come weeks later).
                beforeDay: history ? lateNotes(window[window.length - 1]) : undefined,
                afterUid: byDate ? null : bookmark,
                overlapSince: byDate
                  ? undefined
                  : addDays(window[window.length - 1], -OVERLAP_DAYS),
              },
            );
          } catch (err) {
            problems.push(`${label(acc)}: mailbox search failed: ${err.message}`);
            unreachable.add(acc);
            continue;
          }
          // Read by date (--day, history): every message counts as new.
          const isNew = (uid) => byDate || bookmark == null || uid > bookmark;
          const siblings = mine.filter((s) => s !== acc && s.broker === acc.broker);
          const { byDay, unread } = notesByDay(messages, acc, siblings);

          for (const msg of unread.filter((m) => isNew(m.uid))) {
            problems.push(
              `${label(acc)}: a message matched the note search but no note could be read from it — "${hideId(msg.subject, acc)}" (${msg.attachments.map((a) => hideId(a.filename, acc)).join(', ') || 'no PDF'}); has the broker changed its subject or file name?`,
            );
          }

          for (const [day, found] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
            // Reading by date keeps to its range; the nightly run stores a late note for any day.
            if (byDate && (day < window[0] || day > window[window.length - 1])) continue;
            const existing =
              status.get(key(day, acc.broker, acc.accountId)) ??
              readDay(root, day).find(
                (l) => l.broker === acc.broker && l.account === acc.accountId,
              );
            const stored = existing?.status === 'note' ? existing.note?.sha256 : null;
            let notes = found;
            if (!opts.day && stored) {
              const replaced = new Set(existing.superseded ?? []);
              const others = found.filter((n) => n.sha256 !== stored && !replaced.has(n.sha256));
              for (const n of others.filter((o) => isNew(o.uid))) {
                problems.push(
                  `${label(acc)} ${day}: a second, different note arrived (${hideId(n.attachment, acc)}); the stored one is kept — compare them, then \`node run.js --day ${day}\` takes the newest`,
                );
              }
              continue;
            }
            if (notes.length > 1) {
              if (!opts.day) {
                if (!stored) {
                  fail(
                    acc,
                    day,
                    `${notes.length} different notes in the mailbox — compare them, then \`node run.js --day ${day}\` takes the newest`,
                  );
                }
                continue;
              }
              notes = [...notes].sort((a, b) =>
                String(a.received).localeCompare(String(b.received)),
              );
            }
            const note = notes[notes.length - 1];
            const superseded = notes.slice(0, -1);

            let file;
            if (opts.dryRun) {
              file = path.join(scratch, `${acc.broker}-${day}.pdf`);
              fs.writeFileSync(file, note.content);
            } else {
              file = saveRaw(root, acc.broker, acc.accountId, day, note.content).file;
              for (const old of superseded) {
                fs.writeFileSync(
                  file.replace(/\.pdf$/, `.${old.sha256.slice(0, 8)}.pdf`),
                  old.content,
                );
              }
            }
            const read = await d.readNote(file, acc);
            if (read.error) {
              fail(
                acc,
                day,
                `${read.error} (${note.attachment}) — fix it, then \`node run.js --day ${day}\``,
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
            if (superseded.length) line.superseded = superseded.map((n) => n.sha256);
            write(line);
            const was = existing && existing.status !== 'note' ? ` (was ${existing.status})` : '';
            d.log(
              `note  ${day} ${label(acc)}: final net ${line.fno.final_net}, obligation ${line.fno.payin_payout_obligation}, charges ${line.fno.total_charges}${was}`,
            );
          }

          if (!byDate) {
            const newest = messages.reduce((m, msg) => Math.max(m, msg.uid ?? 0), 0);
            const last = Math.max(bookmark ?? 0, newest);
            cursors[cursorKey] = {
              ...cursor,
              uidvalidity: conn.uidvalidity,
              ...(last ? { last_uid: last } : {}),
              checked_at: at,
            };
          }
          d.log(
            `read  ${label(acc)}: ${messages.filter((m) => isNew(m.uid)).length} new message(s)${!byDate && bookmark != null ? ` after #${bookmark}` : ` since ${addDays(window[0], -1)}`}`,
          );
        }
      } finally {
        conn.imap.end();
      }
    }

    if (!opts.day) {
      // Sessions of accounts whose mailbox could not be read are not judged this run.
      const judged = accounts.filter((acc) => !unreachable.has(acc));
      const { lines, quiet } = closeWithoutNotes(window, judged, status, at);
      for (const line of lines) {
        write(line);
        d.log(
          `${line.status.padEnd(5)} ${line.day} ${label({ broker: line.broker, accountId: line.account })}: ${line.reason}`,
        );
      }
      // A quiet spell alerts on the day it begins (every run that day, so a retry that
      // succeeds cannot swallow it), and not again until a note has arrived. Not from history.
      for (const mailbox of history ? [] : config) {
        for (const acc of mailbox.accounts.filter((a) => judged.includes(a))) {
          const cursorKey = `${mailbox.email}|${acc.broker}/${acc.accountId}`;
          const cursor = cursors[cursorKey] ?? {};
          if (quiet.includes(acc)) {
            cursor.quiet_since ??= today;
            if (cursor.quiet_since === today) {
              problems.push(
                `${label(acc)}: no contract note in the last ${window.length} sessions — is the account still trading, and is its note still mailed to this mailbox?`,
              );
            }
            cursors[cursorKey] = cursor;
          } else if (cursor.quiet_since) {
            delete cursor.quiet_since;
          }
        }
      }
      for (const acc of judged) {
        for (const day of window) {
          const line = status.get(key(day, acc.broker, acc.accountId));
          if (line?.status === 'failed' && !touched.has(key(day, acc.broker, acc.accountId))) {
            problems.push(`${label(acc)} ${day}: still not read — ${hideId(line.reason, acc)}`);
          }
        }
      }
      const waiting = openPairs(window, accounts, status);
      const shown = waiting.slice(0, 20).map((p) => `${p.day} ${label(p)}`);
      d.log(
        `done: ${waiting.length} account-session(s) waiting for a note${shown.length ? `: ${shown.join(', ')}${waiting.length > shown.length ? ', …' : ''}` : ''}`,
      );
      if (history) {
        for (const acc of accounts) {
          const count = (st) =>
            window.filter((day) => status.get(key(day, acc.broker, acc.accountId))?.status === st)
              .length;
          d.log(
            `total ${label(acc)} ${window[0]} → ${window[window.length - 1]}: ${count('note')} notes, ${count('no_trade')} no trade, ${count('failed')} failed, ${window.length - count('note') - count('no_trade') - count('failed') - count('no_note')} open`,
          );
        }
      }
    }
    // Only the nightly run owns the bookmarks: --day and history never write them back.
    if (!opts.dryRun && !byDate) writeCursors(root, cursors);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    release();
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
