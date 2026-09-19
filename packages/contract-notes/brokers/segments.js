const Decimal = require('decimal.js');

// Contract notes settle several exchange segments in a single note: the
// "obligation" table carries one row per exchange/segment (equity derivatives,
// cash/equity, currency, commodity...). This pipeline tracks equity-derivative
// (F&O) P&L only, so an equity trade taken on the same day must not leak into
// the numbers. Each broker parses its own table shape and uses the helpers here
// to keep only the F&O rows.

// Matched in this order: a label is checked against the non-equity segments
// first, then F&O, then cash/equity. Labels are upper-cased and stripped of
// whitespace/dots first, so "NSE FNO - NCL" and "NSEFNO-NCL" classify alike.
const OTHER_SEGMENT =
  /(CURRENCY|CUR\b|CDS|CD\b|COMMODITY|COMM|COM\b|MCX|NCDEX|DEBT|SLB|IRF|GSEC|GOLD)/;
const FNO_SEGMENT = /(FNO|F&O|FO\b|FUT|OPT|DERIV)/;
// CAP covers Finvasia's "NSECAP-NCL" / "BSECAP-ICCL" as well as the spelled-out
// CAPITAL that Angel One uses for the same cash segment.
const EQUITY_SEGMENT = /(CASH|EQUITY|CAP|DELIVERY|INTRADAY|EQ\b|CM\b)/;

const TOTAL_ROW = /^(TOTAL|GRANDTOTAL|NETTOTAL|SUMMARY)/;

function normaliseLabel(label) {
  return String(label == null ? '' : label)
    .toUpperCase()
    .replace(/[\s.]+/g, '');
}

// A summary row ("TOTAL(NET)") aggregates every segment, so it is never a
// segment in its own right and must be skipped rather than classified.
function isTotalRow(label) {
  return TOTAL_ROW.test(normaliseLabel(label));
}

// "fno" rows are the ones we keep. "equity" and "other" are known segments we
// deliberately drop. "unknown" means a label this pipeline has never seen —
// callers should fail loudly rather than guess, since silently keeping or
// dropping it would corrupt the daily P&L.
function classifySegment(label) {
  const s = normaliseLabel(label);
  if (!s) return 'unknown';
  if (OTHER_SEGMENT.test(s)) return 'other';
  if (FNO_SEGMENT.test(s)) return 'fno';
  if (EQUITY_SEGMENT.test(s)) return 'equity';
  return 'unknown';
}

// Pulls the numeric cells out of a table row, tolerating thousands separators.
//
// Returns Decimal instances, not plain numbers: these are real-money rupee
// amounts that get summed, subtracted and compared across several rows
// downstream (brokers/finvasia.js, brokers/angelone.js, ../updateSheet.js),
// and native JS number arithmetic is not exact for base-10 fractions (e.g.
// 0.1 + 0.2 === 0.30000000000000004). Constructing the Decimal directly from
// the matched digit string (after stripping thousands separators) — rather
// than via Number.parseFloat first — also avoids ever routing the value
// through a binary float, so no precision is lost even before the first
// arithmetic operation.
function parseAmounts(chunk) {
  const matches = String(chunk == null ? '' : chunk).match(/-?\d+(?:,\d{3})*\.\d{2}/g);
  if (!matches) return [];
  return matches.map((n) => new Decimal(n.replace(/,/g, '')));
}

// Splits the obligation table into { label, amounts } rows, classifies them and
// reports which segments were kept and which were dropped.
function splitBySegment(rows) {
  const kept = [];
  const dropped = [];
  const unknown = [];

  for (const row of rows) {
    if (isTotalRow(row.label)) continue;
    const kind = classifySegment(row.label);
    if (kind === 'fno') kept.push(row);
    else if (kind === 'unknown') unknown.push(row.label);
    else dropped.push(`${row.label} (${kind})`);
  }

  return { kept, dropped, unknown };
}

module.exports = {
  normaliseLabel,
  isTotalRow,
  classifySegment,
  parseAmounts,
  splitBySegment,
};
