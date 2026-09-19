const finvasia = require("./finvasia");
const angelone = require("./angelone");

const BROKERS = { finvasia, angelone };

const SEP = "__";

function getBroker(name) {
  const b = BROKERS[name];
  if (!b) {
    throw new Error(
      `Unknown broker "${name}". Supported: ${Object.keys(BROKERS).join(", ")}`
    );
  }
  return b;
}

function loadBrokerAccounts() {
  const raw = process.env.BROKER_ACCOUNTS_JSON;
  if (!raw) throw new Error("BROKER_ACCOUNTS_JSON env var is required");

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`BROKER_ACCOUNTS_JSON is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(config)) {
    throw new Error("BROKER_ACCOUNTS_JSON must be a JSON array of mailboxes");
  }

  for (const mb of config) {
    if (!mb.email || !mb.emailPassword || !Array.isArray(mb.accounts)) {
      throw new Error(
        `Each mailbox needs { email, emailPassword, accounts[] }; got ${JSON.stringify(mb)}`
      );
    }
    for (const acc of mb.accounts) {
      if (!acc.broker || !acc.accountId || !acc.pdfPassword) {
        throw new Error(
          `Each account needs { broker, accountId, pdfPassword, sheetStartColumn }; got ${JSON.stringify(acc)}`
        );
      }
      if (!acc.sheetStartColumn || !/^[A-Z]+$/.test(acc.sheetStartColumn)) {
        throw new Error(
          `Account ${acc.accountId} needs sheetStartColumn as an A-Z letter (e.g. "D"); got ${JSON.stringify(acc.sheetStartColumn)}`
        );
      }
      getBroker(acc.broker);
    }
  }
  return config;
}

function flattenAccounts(config) {
  const flat = [];
  for (const mb of config) {
    for (const acc of mb.accounts) {
      flat.push({
        email: mb.email,
        broker: acc.broker,
        accountId: acc.accountId,
        sheetStartColumn: acc.sheetStartColumn,
      });
    }
  }
  return flat;
}

function safeEmail(email) {
  return email.replace(/[@.]/g, "_");
}

function makeFileName(email, broker, accountId, originalName) {
  return `${safeEmail(email)}${SEP}${broker}${SEP}${accountId}${SEP}${originalName}`;
}

function parseFileName(filename) {
  let name = filename;
  if (name.endsWith("_decrypted.pdf")) {
    name = name.slice(0, -"_decrypted.pdf".length) + ".pdf";
  }
  const parts = name.split(SEP);
  if (parts.length < 4) return null;
  return {
    email: parts[0],
    broker: parts[1],
    accountId: parts[2],
    originalName: parts.slice(3).join(SEP),
  };
}

module.exports = {
  BROKERS,
  getBroker,
  loadBrokerAccounts,
  flattenAccounts,
  makeFileName,
  parseFileName,
};
