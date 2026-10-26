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
 * One read-only connection to a Gmail mailbox, opened on All Mail so an archived or labelled
 * note is still found. Never marks anything read.
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
    imap.once('error', reject);
    imap.once('ready', () => {
      imap.openBox('[Gmail]/All Mail', true, (err, box) =>
        err
          ? reject(err)
          : resolve({ imap, uidvalidity: String(box.uidvalidity), uidnext: box.uidnext }),
      );
    });
    imap.connect();
  });
}

/** IMAP's SINCE takes a date, not a time: 'YYYY-MM-DD' → '23-Oct-2026'. */
function imapDate(day) {
  const [y, m, d] = day.split('-').map(Number);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d}-${mon[m - 1]}-${y}`;
}

/**
 * Every message whose subject contains `subjectText` and that is newer than the bookmark
 * (`afterUid`: Gmail's message numbers only grow within one UIDVALIDITY) or, with no bookmark,
 * received on or after `sinceDay`. With its PDF attachments:
 * [{ uid, subject, received, attachments: [{ filename, content }] }], oldest first.
 */
function searchNotes(imap, subjectText, { sinceDay, afterUid }) {
  const range = afterUid != null ? ['UID', `${afterUid + 1}:*`] : ['SINCE', imapDate(sinceDay)];
  return new Promise((resolve, reject) => {
    imap.search([range, ['SUBJECT', subjectText]], (err, found) => {
      if (err) return reject(err);
      // "n:*" always matches the newest message, even when it is older than n.
      const uids = (found || []).filter((u) => afterUid == null || u > afterUid);
      if (!uids.length) return resolve([]);
      const parses = [];
      const f = imap.fetch(uids, { bodies: '' });
      f.on('message', (msg) => {
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

module.exports = { decryptWithQpdf, hasQpdf, connect, searchNotes, imapDate };
