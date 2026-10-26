const Imap = require('imap');
const { simpleParser } = require('mailparser');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const logger = require('./utils/logger');

// qpdf exit codes: 0 = clean, 3 = succeeded with warnings (the output file is
// still written and readable), anything else = real failure. Treating 3 as a
// failure throws away perfectly good contract notes, so only 0 and 3 count as
// success — and qpdf's own stderr is surfaced, since "invalid password" and
// "can't find PDF header" need very different fixes.
const QPDF_WARNINGS = 3;

function decryptWithQpdf(filePath, password, outPath) {
  const decryptedPath = outPath || filePath.replace(/\.pdf$/i, '_decrypted.pdf');
  const file = path.basename(filePath);

  const result = spawnSync(
    'qpdf',
    [`--password=${password}`, '--decrypt', filePath, decryptedPath],
    { encoding: 'utf8', timeout: 30000 },
  );

  if (result.error) {
    const reason =
      result.error.code === 'ENOENT' ? 'qpdf binary not found on PATH' : result.error.message;
    logger.error('qpdf could not be run', null, { file, error: reason });
    return { path: null, error: reason };
  }

  // qpdf never echoes the password back, so its stderr is safe to log.
  const stderr = (result.stderr || '').trim();
  const wroteOutput = fs.existsSync(decryptedPath) && fs.statSync(decryptedPath).size > 0;

  if (result.status === 0 || (result.status === QPDF_WARNINGS && wroteOutput)) {
    if (result.status === QPDF_WARNINGS) {
      logger.warn('PDF decrypted with qpdf warnings', { file, warnings: stderr });
    }
    return { path: decryptedPath, error: null };
  }

  const error = stderr || `qpdf exited with status ${result.status}`;
  logger.error('qpdf failed to decrypt', null, { file, status: result.status, error });
  return { path: null, error };
}

/** True when the qpdf binary runs (Homebrew's on the laptop). */
function hasQpdf() {
  return spawnSync('qpdf', ['--version']).status === 0;
}

/**
 * One read-only connection to a Gmail mailbox, opened on All Mail (found by its \\All flag
 * when the account's language renames "[Gmail]/All Mail") so an archived or labelled note is
 * still found. Never marks anything read.
 */
function connect(mailbox) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: mailbox.email,
      password: mailbox.emailPassword,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { servername: 'imap.gmail.com', minVersion: 'TLSv1.2' },
      connTimeout: 30000,
      authTimeout: 30000,
    });
    const fail = (err) => {
      imap.end();
      reject(err);
    };
    // A listener for the whole connection: an 'error' with none attached would crash the run.
    imap.on('error', (err) => {
      imap.lastError = err;
      reject(err);
    });
    imap.once('ready', () => {
      const opened = (err, box) =>
        err ? fail(err) : resolve({ imap, uidvalidity: String(box.uidvalidity) });
      imap.openBox('[Gmail]/All Mail', true, (err, box) => {
        if (!err) return opened(null, box);
        imap.getBoxes((listErr, boxes) => {
          const all = listErr ? null : findAllMail(boxes);
          if (!all) return fail(err);
          imap.openBox(all, true, opened);
        });
      });
    });
    imap.connect();
  });
}

function findAllMail(boxes, prefix = '') {
  for (const [name, box] of Object.entries(boxes || {})) {
    const full = prefix + name;
    if ((box.attribs || []).includes('\\All')) return full;
    const inner = findAllMail(box.children, full + (box.delimiter || '/'));
    if (inner) return inner;
  }
  return null;
}

/** A mail's body as plain text: its text part, or its HTML with tags dropped and ₹ decoded. */
function bodyText(mail) {
  const raw =
    mail.text ||
    (mail.html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>|<\/(p|div|tr|td|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
  return raw
    .replace(/&#x20B9;|&#8377;/gi, '₹')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ');
}

/** IMAP's SINCE takes a date, not a time: 'YYYY-MM-DD' → '23-Oct-2026'. */
function imapDate(day) {
  const [y, m, d] = day.split('-').map(Number);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d}-${mon[m - 1]}-${y}`;
}

/**
 * Every message whose subject contains `subjectText` and that is newer than the bookmark
 * (`afterUid`: Gmail's message numbers only grow within one UIDVALIDITY) or received on or after
 * `overlapSince` (a few days back, for a note Gmail indexed late or one that failed); with no
 * bookmark, every one received on or after `sinceDay`. With its PDF attachments:
 * [{ uid, subject, received, attachments: [{ filename, content }] }], oldest first.
 */
// Gives up when the mailbox sends nothing for this long; a long download that keeps arriving
// (a year of notes for a history run) is never cut off.
const IDLE_TIMEOUT_MS = 120000;

function searchNotes(imap, subjectText, { sinceDay, beforeDay, afterUid, overlapSince }) {
  let range = ['SINCE', imapDate(sinceDay)];
  if (beforeDay) range = [range, ['BEFORE', imapDate(beforeDay)]];
  if (afterUid != null) {
    range = ['UID', `${afterUid + 1}:*`];
    if (overlapSince) range = ['OR', range, ['SINCE', imapDate(overlapSince)]];
  }
  let timer;
  let touch;
  let settled = false;
  const idle = new Promise((_, reject) => {
    touch = () => {
      clearTimeout(timer);
      if (settled) return;
      timer = setTimeout(() => {
        settled = true;
        reject(imap.lastError || new Error('the mailbox stopped answering'));
      }, IDLE_TIMEOUT_MS);
    };
    touch();
  });
  return Promise.race([search(imap, subjectText, range, () => touch()), idle]).finally(() => {
    settled = true;
    clearTimeout(timer);
  });
}

function search(imap, subjectText, range, touch) {
  return new Promise((resolve, reject) => {
    const criteria = Array.isArray(range[0]) ? [...range] : [range];
    imap.search([...criteria, ['SUBJECT', subjectText]], (err, found) => {
      if (err) return reject(err);
      // "n:*" also matches the newest message when it is older than n: harmless, a stored note
      // is skipped by its hash and alerts are raised only for messages past the bookmark.
      const uids = found || [];
      if (!uids.length) return resolve([]);
      const parses = [];
      touch();
      const f = imap.fetch(uids, { bodies: '' });
      f.on('message', (msg) => {
        touch();
        let uid = null;
        msg.once('attributes', (attrs) => {
          uid = attrs.uid;
        });
        msg.on('body', (stream) => {
          parses.push(
            simpleParser(stream).then((mail) => ({
              uid,
              subject: mail.subject || '',
              received: mail.date ? mail.date.toISOString() : null,
              messageId: mail.messageId || null,
              from: mail.from?.value?.[0]?.address || '',
              text: bodyText(mail),
              attachments: (mail.attachments || [])
                .filter((a) => a.filename?.toLowerCase().endsWith('.pdf'))
                .map((a) => ({ filename: a.filename, content: a.content })),
            })),
          );
        });
      });
      f.once('error', reject);
      f.once('end', () =>
        Promise.all(parses).then((msgs) => resolve(msgs.sort((a, b) => a.uid - b.uid)), reject),
      );
    });
  });
}

module.exports = { decryptWithQpdf, hasQpdf, connect, searchNotes, imapDate, bodyText };
