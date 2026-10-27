const fs = require('node:fs');
const path = require('node:path');
const Decimal = require('decimal.js');
const { istNow } = require('./calendar');

// The brokers' ledger e-mails (BL-168 Phase 3): money in and out of an account, and charges or
// warnings that never appear on a contract note. One reader per e-mail, matched by subject and
// sender; each event is a line in ledger/<day>.jsonl, kept once per message.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// A rupee amount: the symbol (or a whole-word Rs / INR), then digits — never a lone comma.
const RUPEES = String.raw`(?:₹|\bRs\.?|\bINR)\s*(\d[\d,]*(?:\.\d{1,2})?)`;
const money = (text) => new Decimal(text.replace(/,/g, '')).toDecimalPlaces(2).toNumber();
const one = (text) => String(text).replace(/\s+/g, ' ');

/** "14-Oct-2026" → '2026-10-14'. */
function dmy(text) {
  const m = /(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/**
 * Each reader: the broker whose accounts it belongs to, the IMAP subject to search, the sender's
 * domain, and `read(text)` → the event's fields, or null when the e-mail says something else
 * (reported, never skipped). `day` defaults to the day the e-mail was received (IST).
 */
const READERS = [
  {
    kind: 'deposit',
    broker: 'angelone',
    subject: 'Funds added successfully',
    from: 'angelone.in',
    read(text) {
      const m = new RegExp(`added\\s*${RUPEES}`, 'i').exec(one(text));
      return m ? { amount: money(m[1]) } : null;
    },
  },
  {
    kind: 'collateral_interest',
    broker: 'angelone',
    subject: 'Interest on collateral used against your derivative trade',
    from: 'angelone.in',
    read(text) {
      const t = one(text);
      const m = new RegExp(
        `interest of\\s*${RUPEES}.*?used on\\s*(\\d{4}-\\d{2}-\\d{2}).*?shortfall was\\s*${RUPEES}`,
        'i',
      ).exec(t);
      return m ? { amount: money(m[1]), day: m[2], shortfall: money(m[3]) } : null;
    },
  },
  {
    kind: 'margin_warning',
    broker: 'angelone',
    subject: 'Margin Shortfall Intimation',
    from: 'angelone.in',
    // "… reached NN.NN% of your available margin as on DD-Mon-YYYY, HH:MM:SS AM." (Oct 2026 on)
    // or "… as on YYYY-MM-DD HH:MM:SS." (Sep 2026); then "Margin Available ₹ x", "Margin
    // Utilised* ₹ y".
    read(text) {
      const t = one(text);
      const m =
        /reached\s*([\d.]+)%\s*of your available margin as on\s*(?:(\d{1,2}-[A-Za-z]{3}-\d{4}),\s*(\d{1,2}:\d{2}:\d{2}\s*[AP]M)|(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}))/i.exec(
          t,
        );
      if (!m) return null;
      const available = new RegExp(`Margin Available\\s*${RUPEES}`, 'i').exec(t);
      const used = new RegExp(`Margin Utilised\\*?\\s*${RUPEES}`, 'i').exec(t);
      return {
        utilisation_pct: Number(m[1]),
        day: m[2] ? dmy(m[2]) : m[4],
        time: m[3] ? m[3].toUpperCase() : m[5],
        ...(available ? { margin_available: money(available[1]) } : {}),
        ...(used ? { margin_used: money(used[1]) } : {}),
      };
    },
  },
  {
    kind: 'withdrawal',
    broker: 'kite',
    subject: 'Instant payout request processed',
    from: 'zerodha.com',
    read(text) {
      const t = one(text);
      const m = new RegExp(`payout request for\\s*${RUPEES}`, 'i').exec(t);
      if (!m) return null;
      const on = /deposited.*?on\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/i.exec(t);
      return { amount: money(m[1]), ...(on ? { day: dmy(on[1]) } : {}) };
    },
  },
  {
    // Finvasia's quarterly settlement e-mail carries no amount: the event is recorded so the
    // money page can mark the day; the amount comes from the ledger statement, by hand.
    kind: 'settlement',
    broker: 'finvasia',
    subject: 'Quarterly Fund Settlement',
    from: 'shoonya.com',
    read(text) {
      const m = new RegExp(RUPEES, 'i').exec(one(text));
      return { amount: m ? money(m[1]) : null };
    },
  },
];

/**
 * The events in `messages` for one reader and one account: { events, unread }. `unread` holds
 * messages from the right sender that the reader could not understand.
 */
function readLedger(reader, messages, account) {
  const events = [];
  const unread = [];
  for (const msg of messages) {
    const from = String(msg.from ?? '').toLowerCase();
    if (!(from.endsWith(`@${reader.from}`) || from.endsWith(`.${reader.from}`))) continue;
    const fields = msg.received ? reader.read(msg.text || '') : null;
    // A day the reader found but could not turn into a date is not understood either.
    if (!fields || ('day' in fields && !fields.day)) {
      unread.push(msg);
      continue;
    }
    const { day, ...rest } = fields;
    events.push({
      day: day ?? istNow(new Date(msg.received)).day,
      broker: reader.broker,
      account,
      kind: reader.kind,
      ...rest,
      day_source: day ? 'e-mail' : 'received',
      message_id: msg.messageId ?? `${msg.uid}|${msg.received}|${msg.subject}`,
      received: msg.received,
    });
  }
  return { events, unread };
}

function ledgerFile(root, day) {
  return path.join(root, 'ledger', `${day}.jsonl`);
}

/** Every event stored for `day`. */
function readLedgerDay(root, day) {
  try {
    return fs
      .readFileSync(ledgerFile(root, day), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Store an event once per message (atomically). Returns whether it was new. */
function writeEvent(root, event) {
  const file = ledgerFile(root, event.day);
  const events = readLedgerDay(root, event.day);
  if (events.some((e) => e.message_id === event.message_id && e.kind === event.kind)) return false;
  events.push(event);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  fs.renameSync(tmp, file);
  return true;
}

module.exports = { READERS, readLedger, readLedgerDay, writeEvent, dmy };
