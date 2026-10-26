const finvasia = require('./finvasia');
const angelone = require('./angelone');

// A plugin exports searchSubject(accountId), noteDay({ subject, filename, accountId }) and
// extract(text). An account whose broker has no plugin yet (`kite` until BL-168 Phase 3) is
// skipped by the run with a notice, not refused, so it can sit in BROKER_ACCOUNTS_JSON early.
const BROKERS = { finvasia, angelone };

function getBroker(name) {
  const b = BROKERS[name];
  if (!b) {
    throw new Error(`Unknown broker "${name}". Supported: ${Object.keys(BROKERS).join(', ')}`);
  }
  return b;
}

function isSupported(name) {
  return Object.hasOwn(BROKERS, name);
}

// Never echoes the config: it holds the Gmail and PDF passwords.
function loadBrokerAccounts(raw = process.env.BROKER_ACCOUNTS_JSON) {
  if (!raw) throw new Error('BROKER_ACCOUNTS_JSON env var is required');

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `BROKER_ACCOUNTS_JSON is not valid JSON (${raw.length} characters; it must be on one line in .env): ${err.message}`,
    );
  }
  if (!Array.isArray(config)) {
    throw new Error('BROKER_ACCOUNTS_JSON must be a JSON array of mailboxes');
  }

  config.forEach((mb, i) => {
    if (!mb.email || !mb.emailPassword || !Array.isArray(mb.accounts)) {
      throw new Error(`Mailbox ${i + 1} needs { email, emailPassword, accounts[] }`);
    }
    mb.accounts.forEach((acc, j) => {
      if (!acc.broker || !acc.accountId || !acc.pdfPassword) {
        throw new Error(
          `Mailbox ${i + 1}, account ${j + 1} needs { broker, accountId, pdfPassword }`,
        );
      }
    });
  });
  return config;
}

module.exports = { BROKERS, getBroker, isSupported, loadBrokerAccounts };
