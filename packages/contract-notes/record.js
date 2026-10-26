const Decimal = require('decimal.js');

// What a stored day line holds, and when a session is done for an account (BL-168).
// Pure functions: run.js does the mail, the PDFs and the files.

const SCHEMA = 1;

/**
 * The note's F&O figures as the sheet's five columns. Money stays in Decimal until this
 * boundary (repo rule): total_charges and final_net are derived here, never with native +/-.
 */
function fnoBlock(extracted) {
  const payin = new Decimal(extracted.payin_payout_obligation ?? 0);
  const brokerage = new Decimal(extracted.net_brokerage ?? 0);
  const other = new Decimal(extracted.other_charges ?? 0);
  const total = brokerage.plus(other);
  return {
    payin_payout_obligation: payin.toNumber(),
    net_brokerage: brokerage.toNumber(),
    other_charges: other.toNumber(),
    total_charges: total.toNumber(),
    final_net: payin.minus(total).toNumber(),
  };
}

function noteLine({ day, broker, account, extracted, note, at }) {
  return {
    schema: SCHEMA,
    day,
    broker,
    account,
    status: 'note',
    source: 'email',
    fno: fnoBlock(extracted),
    skipped_segments: extracted.skipped_segments ?? [],
    note: {
      sha256: note.sha256,
      file: note.file,
      subject: note.subject,
      received: note.received,
      attachment: note.attachment,
    },
    recorded_at: at,
  };
}

function closedLine({ day, broker, account, status, reason, at }) {
  return { schema: SCHEMA, day, broker, account, status, reason, recorded_at: at };
}

// A line with any of these statuses closes the session for its account. 'no_note' is the
// quiet close for an account with no note at all in the window (one not trading lately); it
// is reported once, when an account first goes quiet.
const CLOSED = new Set(['note', 'no_trade', 'no_note']);

const key = (day, broker, account) => `${day}|${broker}/${account}`;

/**
 * The (session, account) pairs still waiting for a note: every session in `sessions` (oldest
 * first) with no closing line in `status`.
 */
function openPairs(sessions, accounts, status) {
  const open = [];
  for (const acc of accounts) {
    for (const day of sessions) {
      const line = status.get(key(day, acc.broker, acc.accountId));
      if (!line || !CLOSED.has(line.status)) open.push({ day, ...acc });
    }
  }
  return open;
}

/**
 * Lines that close sessions without a note. A broker sends a note only for a day with trades,
 * so:
 * - a session before the account's newest stored note, with no note of its own, had no trade
 *   (`no_trade`): the later note proves the mailbox is current for that account;
 * - the oldest session of the window, still open with no note anywhere in the window, is
 *   `no_note`: the account has been quiet for the whole window. Leaving it open would re-scan
 *   it forever. `newlyQuiet` lists the accounts whose session before the window
 *   (`previousSession`, its line in `status` too) was not already `no_note`, so the caller
 *   alerts once per quiet spell, not every day.
 */
function closeWithoutNotes(sessions, accounts, status, at, previousSession) {
  const lines = [];
  const newlyQuiet = [];
  for (const acc of accounts) {
    const get = (day) => status.get(key(day, acc.broker, acc.accountId));
    const noteDays = sessions.filter((d) => get(d)?.status === 'note');
    const newest = noteDays[noteDays.length - 1];
    for (const day of sessions) {
      if (CLOSED.has(get(day)?.status)) continue;
      if (newest && day < newest) {
        lines.push(
          closedLine({
            day,
            broker: acc.broker,
            account: acc.accountId,
            status: 'no_trade',
            reason: `no note, and the note for ${newest} has arrived`,
            at,
          }),
        );
      }
    }
    const oldest = sessions[0];
    if (!newest && oldest && !CLOSED.has(get(oldest)?.status)) {
      lines.push(
        closedLine({
          day: oldest,
          broker: acc.broker,
          account: acc.accountId,
          status: 'no_note',
          reason: `no note for this account in the ${sessions.length} sessions to ${sessions[sessions.length - 1]}`,
          at,
        }),
      );
      if (get(previousSession)?.status !== 'no_note') newlyQuiet.push(acc);
    }
  }
  return { lines, newlyQuiet };
}

module.exports = { fnoBlock, noteLine, closedLine, openPairs, closeWithoutNotes, key, CLOSED };
