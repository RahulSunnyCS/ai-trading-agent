const fs = require('node:fs');
const path = require('node:path');

// The same holidays.csv packages/market-reference reads (and the Python engine), so the three
// can never disagree about which days traded. Read by relative path for the same reason
// market-reference does: there is no second copy to drift.
const HOLIDAYS_CSV = path.join(
  __dirname,
  '..',
  'option-backtesting',
  'src',
  'option_backtesting',
  'data',
  'reference',
  'holidays.csv',
);

let holidays = null;

function loadHolidays() {
  const [, ...rows] = fs.readFileSync(HOLIDAYS_CSV, 'utf8').trim().split('\n');
  // Only the first column is read, so a comma inside a quoted description is harmless.
  return new Set(rows.map((line) => line.split(',')[0].trim()).filter(Boolean));
}

/** True for a weekday ('YYYY-MM-DD', IST) that is not an NSE holiday. */
function isTradingDay(day) {
  holidays ??= loadHolidays();
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(day);
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The IST calendar date and 'HH:MM' of an instant (India has no DST: fixed +05:30). */
function istNow(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60 * 1000).toISOString();
  return { day: ist.slice(0, 10), hhmm: ist.slice(11, 16) };
}

// A session's notes start arriving that evening; before this the day's own note cannot exist.
const NOTES_FROM = '16:00';

/** The newest session whose note may already be in the mailbox. */
function lastSession(now = new Date()) {
  const { day, hhmm } = istNow(now);
  let d = isTradingDay(day) && hhmm >= NOTES_FROM ? day : addDays(day, -1);
  while (!isTradingDay(d)) d = addDays(d, -1);
  return d;
}

/** The `n` trading days ending at `last` (inclusive), oldest first. */
function sessionsBack(last, n) {
  const out = [];
  for (let d = last; out.length < n; d = addDays(d, -1)) {
    if (isTradingDay(d)) out.unshift(d);
  }
  return out;
}

module.exports = { isTradingDay, addDays, istNow, lastSession, sessionsBack };
