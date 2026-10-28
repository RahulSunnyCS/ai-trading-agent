const Decimal = require('decimal.js');
const { parseAmounts, splitBySegment } = require('./segments');
const logger = require('../utils/logger');
const { chooseTrades } = require('./fnoTrades');

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Order in which pdf-parse emits the "Obligation Detail" cells for each
// exchange/segment row. It follows the PDF's draw order, which is not the
// printed header order — the arithmetic check below guards against drift.
const COL = {
  STT: 0,
  TAXABLE: 1, // Taxable value of supply = brokerage + txn charges + SEBI fees + clearing + IPF
  IGST: 2,
  SEBI: 3,
  STAMP: 4,
  TRANSACTION: 5,
  NET: 6, // Final Net
  OBLIGATION: 7, // Pay in/Payout Obligation (already net of brokerage)
  CLEARING: 8,
  BROKERAGE: 9,
  IPF: 10,
};
const COLUMN_COUNT = 11;
const CHARGE_COLS = [
  COL.STT,
  COL.IGST,
  COL.SEBI,
  COL.STAMP,
  COL.TRANSACTION,
  COL.CLEARING,
  COL.IPF,
];
const TOLERANCE = 0.05;

// Row labels look like "NSEFNO-NCL" / "NSECASH-NCL" — exchange, segment and
// clearing corporation run together. Notes until 25 Aug 2025 print "NSE FNO" /
// "NSE CAP" instead: exchange and segment, no clearing corporation.
// Any word after the exchange counts as a segment, so an unknown one reaches the hard error in
// segments.js instead of being skipped as text.
const SEGMENT_LABEL =
  /\b((?:NSE|BSE|MSEI|MSE|MCX|NCDEX|ICEX)(?:[A-Z& ]*-\s*[A-Z]+|\s+[A-Z][A-Z&]{1,7}\b))/g;

// IMAP SUBJECT is a substring match: this finds every note for the account, whatever its date.
function searchSubject(accountId) {
  return `Combined Contract Note for ${accountId}`;
}

// "Combined Contract Note for FA1234 23-10-2026" → '2026-10-23' (null if not this account's).
function noteDay({ subject, accountId }) {
  const m = new RegExp(
    `Combined Contract Note for ${escapeRegExp(accountId)}\\s+(\\d{2})-(\\d{2})-(\\d{4})`,
  ).exec(subject || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// n is a Decimal (all money math in this file stays in Decimal until this
// boundary); returns a plain number, since that is what the stored line holds.
function round2(n) {
  return n.toDecimalPlaces(2).toNumber();
}

// The table's header starts "Name Of Exchange/CC & Segment"; until 25 Aug 2025 it started
// "Exchange Pay in/Payout Obligation" (the columns are the same, in the same order).
function obligationBlock(text) {
  let start = text.search(/Name\s*Of\s*Exchange\s*\/\s*CC/i);
  if (start === -1) start = text.search(/Exchange\s*Pay\s*in\s*\/\s*Payout/i);
  if (start === -1) return null;
  const rest = text.slice(start);
  const endMatch = rest.match(/By\s+Client\s+Net\s+Payable/i);
  return endMatch ? rest.slice(0, endMatch.index) : rest;
}

// A row's amounts are everything between its own label and the next one.
function parseRows(block) {
  const labels = [...block.matchAll(SEGMENT_LABEL)];
  return labels.map((m, i) => {
    const from = m.index + m[0].length;
    const to = i + 1 < labels.length ? labels[i + 1].index : block.length;
    return { label: m[1].trim(), amounts: parseAmounts(block.slice(from, to)) };
  });
}

function extract(text) {
  if (!text) return { error: 'Finvasia extract received empty text' };

  const block = obligationBlock(text);
  if (!block) {
    const snippet = text.slice(0, 500).replace(/\n/g, ' ');
    return { error: `Finvasia Obligation Detail table not found. Text preview: ${snippet}` };
  }

  const rows = parseRows(block);
  if (!rows.length) {
    const snippet = block.slice(0, 500).replace(/\n/g, ' ');
    return { error: `Finvasia exchange/segment rows not matched. Text preview: ${snippet}` };
  }

  const { kept, dropped, unknown } = splitBySegment(rows);
  if (unknown.length) {
    return {
      error:
        `Finvasia obligation row(s) with unrecognised segment: ${unknown.join(', ')}. ` +
        `Add the label to brokers/segments.js so it is classified as F&O or excluded.`,
    };
  }

  // Only the F&O rows are read, so only they must have the full set of cells.
  // A cash or currency row with an odd shape is noted and ignored rather than
  // failing a note whose F&O side parses perfectly well.
  const oddDropped = rows.filter((r) => !kept.includes(r) && r.amounts.length !== COLUMN_COUNT);
  if (oddDropped.length) {
    logger.warn('Finvasia ignored non-F&O row with unexpected cell count', {
      rows: oddDropped.map((r) => `${r.label}=${r.amounts.length}`).join(', '),
    });
  }

  const badRow = kept.find((r) => r.amounts.length !== COLUMN_COUNT);
  if (badRow) {
    const snippet = block.slice(0, 800).replace(/\n/g, ' ');
    return {
      error:
        `Finvasia row "${badRow.label}" has ${badRow.amounts.length} amounts, expected ${COLUMN_COUNT}. ` +
        `Text preview: ${snippet}`,
    };
  }

  // Every row was cash / currency / commodity: no F&O activity to record.
  if (!kept.length) {
    logger.info('Finvasia note has no F&O segment — recording zeros', {
      skipped: dropped.join(', ') || 'none',
    });
    return {
      payin_payout_obligation: 0,
      net_brokerage: 0,
      other_charges: 0,
      skipped_segments: dropped,
    };
  }

  let obligation = new Decimal(0);
  let netAmount = new Decimal(0);
  let brokerage = new Decimal(0);
  let itemisedCharges = new Decimal(0);
  let taxable = new Decimal(0);
  let taxableComponents = new Decimal(0);
  const kinds = {
    stt: COL.STT,
    gst: COL.IGST,
    exchange: COL.TRANSACTION,
    clearing: COL.CLEARING,
    sebi: COL.SEBI,
    stamp: COL.STAMP,
    ipf: COL.IPF,
  };
  const byKind = Object.fromEntries(Object.keys(kinds).map((k) => [k, new Decimal(0)]));

  for (const row of kept) {
    const a = row.amounts;
    if (a.some((n) => !n.isFinite())) {
      return { error: `Finvasia row "${row.label}" contains a non-numeric amount` };
    }
    obligation = obligation.plus(a[COL.OBLIGATION]);
    netAmount = netAmount.plus(a[COL.NET]);
    brokerage = brokerage.plus(a[COL.BROKERAGE]);
    for (const [k, c] of Object.entries(kinds)) byKind[k] = byKind[k].plus(a[c].abs());
    itemisedCharges = itemisedCharges.plus(
      CHARGE_COLS.reduce((sum, c) => sum.plus(a[c]), new Decimal(0)),
    );
    taxable = taxable.plus(a[COL.TAXABLE]);
    taxableComponents = taxableComponents.plus(
      a[COL.BROKERAGE]
        .plus(a[COL.TRANSACTION])
        .plus(a[COL.SEBI])
        .plus(a[COL.CLEARING])
        .plus(a[COL.IPF]),
    );
  }

  // obligation - charges must land on the note's own Final Net; if it does not,
  // the cells were read in the wrong order and the numbers are unsafe.
  const charges = obligation.minus(netAmount);
  if (
    charges
      .minus(itemisedCharges)
      .abs()
      .greaterThan(TOLERANCE * kept.length)
  ) {
    return {
      error:
        `Finvasia column mismatch: obligation ${obligation.toFixed(2)} - final net ${netAmount.toFixed(2)} ` +
        `= ${charges.toFixed(2)}, but itemised charges sum to ${itemisedCharges.toFixed(2)}`,
    };
  }

  // Taxable value of supply = brokerage + transaction + SEBI + clearing + IPF.
  // A mismatch means the brokerage cell is probably not where we think it is.
  // The older layout's taxable value leaves IPF out; either form is accepted.
  const ipf = kept.reduce((sum, r) => sum.plus(r.amounts[COL.IPF]), new Decimal(0));
  const off = (v) =>
    taxable
      .minus(v)
      .abs()
      .greaterThan(TOLERANCE * kept.length);
  if (off(taxableComponents) && off(taxableComponents.minus(ipf))) {
    logger.warn('Finvasia brokerage cross-check failed against taxable value of supply', {
      taxable: taxable.toFixed(2),
      components: taxableComponents.toFixed(2),
    });
  }

  if (dropped.length) {
    logger.info('Finvasia non-F&O segments excluded', { segments: dropped.join(', ') });
  }

  return {
    payin_payout_obligation: round2(obligation),
    net_brokerage: round2(brokerage),
    // |finalNet - obligation| spans brokerage + other charges; strip brokerage to isolate other charges
    other_charges: round2(charges.abs().minus(brokerage)),
    skipped_segments: dropped,
    charges: {
      brokerage: round2(brokerage),
      ...Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, round2(v)])),
    },
    ...chooseTrades(text, 'finvasia', obligation),
  };
}

module.exports = { searchSubject, noteDay, extract };
