require('dotenv').config();
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadBrokerAccounts, getBroker, makeFileName } = require('./brokers');
const { requireEnv } = require('./utils/validate');
const { withRetry } = require('./utils/retry');
const logger = require('./utils/logger');

const targetDate = process.env.TARGET_DATE
  ? new Date(process.env.TARGET_DATE)
  : new Date(Date.now() - 24 * 60 * 60 * 1000);
const formattedDate = targetDate.toISOString().slice(0, 10);

const dataDir = path.join(__dirname, 'data');

// qpdf exit codes: 0 = clean, 3 = succeeded with warnings (the output file is
// still written and readable), anything else = real failure. Treating 3 as a
// failure throws away perfectly good contract notes, so only 0 and 3 count as
// success — and qpdf's own stderr is surfaced, since "invalid password" and
// "can't find PDF header" need very different fixes.
const QPDF_WARNINGS = 3;

function decryptWithQpdf(filePath, password) {
  const decryptedPath = filePath.replace(/\.pdf$/i, '_decrypted.pdf');
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
    } else {
      logger.info('PDF decrypted', { file: path.basename(decryptedPath) });
    }
    return { path: decryptedPath, error: null };
  }

  const error = stderr || `qpdf exited with status ${result.status}`;
  logger.error('qpdf failed to decrypt', null, { file, status: result.status, error });
  return { path: null, error };
}

function fetchAttachmentsForSubject(imap, subjectSearch, bodyFilterStr) {
  return new Promise((resolve, reject) => {
    imap.search(
      [
        ['SINCE', formattedDate],
        ['SUBJECT', subjectSearch],
      ],
      (err, results) => {
        if (err) return reject(err);
        if (!results || !results.length) return resolve([]);

        const attachments = [];
        const parsePromises = [];
        const f = imap.fetch(results, { bodies: '', struct: true });

        f.on('message', (msg) => {
          msg.on('body', (stream) => {
            parsePromises.push(
              simpleParser(stream).then((parsed) => {
                if (bodyFilterStr) {
                  const bodyText = parsed.text || parsed.html || '';
                  if (!bodyText.includes(bodyFilterStr)) return;
                }
                for (const att of parsed.attachments || []) {
                  if (att.filename && att.filename.toLowerCase().endsWith('.pdf')) {
                    attachments.push(att);
                  }
                }
              }),
            );
          });
        });

        f.once('error', reject);
        f.once('end', async () => {
          try {
            await Promise.all(parsePromises);
            resolve(attachments);
          } catch (parseErr) {
            reject(parseErr);
          }
        });
      },
    );
  });
}

async function processMailbox(mailbox) {
  const result = {
    email: mailbox.email,
    succeeded: [],
    failed: [],
    errors: [],
  };

  await new Promise((resolve, reject) => {
    const imap = new Imap({
      user: mailbox.email,
      password: mailbox.emailPassword,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: {
        servername: 'imap.gmail.com',
        minVersion: 'TLSv1.2',
      },
      connTimeout: 30000,
      authTimeout: 15000,
    });

    imap.once('ready', () => {
      imap.openBox('INBOX', false, async (err) => {
        if (err) {
          imap.end();
          return reject(err);
        }

        for (const acc of mailbox.accounts) {
          try {
            const broker = getBroker(acc.broker);
            const subjectSearch = broker.subject(acc.accountId, targetDate);
            const bodyFilterStr = broker.bodyFilter ? broker.bodyFilter(targetDate) : null;
            logger.info(`Searching mail`, {
              email: mailbox.email,
              broker: acc.broker,
              account: acc.accountId,
              subject: subjectSearch,
            });

            const attachments = await fetchAttachmentsForSubject(
              imap,
              subjectSearch,
              bodyFilterStr,
            );
            if (!attachments.length) {
              logger.info('No mail found', { broker: acc.broker, account: acc.accountId });
              continue;
            }

            for (const att of attachments) {
              const filename = makeFileName(mailbox.email, acc.broker, acc.accountId, att.filename);
              const filePath = path.join(dataDir, filename);
              try {
                fs.writeFileSync(filePath, att.content);
                logger.info('Attachment saved', { file: filename });
              } catch (writeErr) {
                logger.error('Failed to save attachment', writeErr, { file: filename });
                result.failed.push(acc.accountId);
                result.errors.push({ account: acc.accountId, error: writeErr.message });
                continue;
              }
              const decryptResult = decryptWithQpdf(filePath, acc.pdfPassword);
              if (decryptResult.error) {
                result.failed.push(acc.accountId);
                result.errors.push({ account: acc.accountId, error: decryptResult.error });
              } else {
                result.succeeded.push(acc.accountId);
              }
            }
          } catch (accErr) {
            logger.error(`Account processing failed`, accErr, { account: acc.accountId });
            result.failed.push(acc.accountId);
            result.errors.push({ account: acc.accountId, error: accErr.message });
          }
        }

        imap.end();
        resolve();
      });
    });

    imap.once('error', (err) => {
      logger.error(`IMAP error`, err, { email: mailbox.email });
      reject(err);
    });

    imap.connect();
  });

  return result;
}

async function main() {
  requireEnv(['BROKER_ACCOUNTS_JSON']);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
  const mailboxes = loadBrokerAccounts();

  const summary = [];
  for (const mb of mailboxes) {
    try {
      const result = await withRetry(() => processMailbox(mb), {
        attempts: 3,
        baseDelayMs: 2000,
        retryIf: (err) => !err.message.includes('Invalid credentials'),
        onRetry: (err, attempt, delay) =>
          logger.warn(`IMAP retry`, {
            email: mb.email,
            attempt,
            delayMs: delay,
            error: err.message,
          }),
      });
      summary.push(result);
    } catch (err) {
      logger.error(`Mailbox processing failed after retries`, err, { email: mb.email });
      summary.push({
        email: mb.email,
        succeeded: [],
        failed: ['all'],
        errors: [{ error: err.message }],
      });
    }
  }

  logger.info('=== Fetch summary ===');
  for (const s of summary) {
    logger.info(`Mailbox result`, {
      email: s.email,
      succeeded: s.succeeded.join(',') || 'none',
      failed: s.failed.join(',') || 'none',
    });
  }

  const anyFailed = summary.some((s) => s.failed.length > 0);
  if (anyFailed) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { decryptWithQpdf, main };
