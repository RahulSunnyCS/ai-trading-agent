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
  const line = { schema: SCHEMA, day, broker, account, status: 'note', source: 'email' };
  if (extracted.eq) {
    // An equity note (Zerodha, Momentum): its own figures and trade rows, no F&O block.
    line.eq = extracted.eq;
    line.trades = extracted.trades ?? [];
  } else {
    line.fno = fnoBlock(extracted);
    line.skipped_segments = extracted.skipped_segments ?? [];
  }
  line.note = {
    sha256: note.sha256,
    file: note.file,
    subject: note.subject,
    received: note.received,
    attachment: note.attachment,
  };
  line.recorded_at = at;
  return line;
}

function closedLine({ day, broker, account, status, reason, at }) {
  return { schema: SCHEMA, day, broker, account, status, reason, recorded_at: at };
}

// A line with any of these statuses closes the session for its account. 'no_note' is the
// quiet close for an account with no note at all in the window (one not trading lately).
// A 'failed' line (a note that could not be read, or two different notes for the session)
// keeps the session open and is never closed as 'no_trade': its note exists.
const CLOSED = new Set(['note', 'no_trade', 'no_note']);

const key = (day, broker, account) => `${day}|${broker}/${account}`;

/**
 * The (session, account) pairs still waiting for a note: every session in `sessions` (oldest
 * first) with no closing line in `status`.
 */
function openPairs(sessions, accounts, status) {
  const open = [];
  for (const acc of accounts) {
    for (const day of sessions.filter((d) => !acc.from || d >= acc.from)) {
      const line = status.get(key(day, acc.broker, acc.accountId));
      if (!line || !CLOSED.has(line.status)) open.push({ day, ...acc });
    }
  }
  return open;
}

/**
 * Lines that close sessions without a note. A broker sends a note only for a day with trades,
 * so:
 * - a session before the account's newest stored note, with no line of its own, had no trade
 *   (`no_trade`): the later note proves the mailbox is current for that account;
 * - the oldest session of the window, with no note and no failed note anywhere in the window,
 *   is `no_note`: the account has been quiet for the whole window. Leaving it open would keep
 *   it waiting for ever.
 * `quiet` lists those quiet accounts (whether or not this call closed a session for them); the
 * caller keeps when each quiet spell began, so it alerts on that day only.
 */
function closeWithoutNotes(allSessions, accounts, status, at) {
  const lines = [];
  const quiet = [];
  for (const acc of accounts) {
    // An account read only from a start day (`from`) has no sessions before it.
    const sessions = allSessions.filter((d) => !acc.from || d >= acc.from);
    if (!sessions.length) continue;
    const get = (day) => status.get(key(day, acc.broker, acc.accountId));
    const noteDays = sessions.filter((d) => get(d)?.status === 'note');
    const failed = sessions.some((d) => get(d)?.status === 'failed');
    const newest = noteDays[noteDays.length - 1];
    for (const day of sessions) {
      if (get(day)) continue; // closed, or failed and waiting for a fix
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
    if (newest || failed) continue;
    quiet.push(acc);
    const oldest = sessions[0];
    if (oldest && !get(oldest)) {
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
    }
  }
  return { lines, quiet };
}

function failedLine({ day, broker, account, reason, at }) {
  return { ...closedLine({ day, broker, account, status: 'failed', reason, at }) };
}

module.exports = {
  fnoBlock,
  noteLine,
  closedLine,
  failedLine,
  openPairs,
  closeWithoutNotes,
  key,
  CLOSED,
};
