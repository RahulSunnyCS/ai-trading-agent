const { parseAmounts, splitBySegment } = require('./segments');
const logger = require('../utils/logger');

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
// clearing corporation run together.
const SEGMENT_LABEL = /\b((?:NSE|BSE|MSEI|MSE|MCX|NCDEX|ICEX)[A-Z& ]*-\s*[A-Z]+)/gi;

function subject(accountId, date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `Combined Contract Note for ${accountId} ${dd}-${mm}-${yyyy}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function obligationBlock(text) {
  const start = text.search(/Name\s*Of\s*Exchange\s*\/\s*CC/i);
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

  let obligation = 0;
  let netAmount = 0;
  let brokerage = 0;
  let itemisedCharges = 0;
  let taxable = 0;
  let taxableComponents = 0;

  for (const row of kept) {
    const a = row.amounts;
    if (a.some((n) => !Number.isFinite(n))) {
      return { error: `Finvasia row "${row.label}" contains a non-numeric amount` };
    }
    obligation += a[COL.OBLIGATION];
    netAmount += a[COL.NET];
    brokerage += a[COL.BROKERAGE];
    itemisedCharges += CHARGE_COLS.reduce((sum, c) => sum + a[c], 0);
    taxable += a[COL.TAXABLE];
    taxableComponents +=
      a[COL.BROKERAGE] + a[COL.TRANSACTION] + a[COL.SEBI] + a[COL.CLEARING] + a[COL.IPF];
  }

  // obligation - charges must land on the note's own Final Net; if it does not,
  // the cells were read in the wrong order and the numbers are unsafe.
  const charges = obligation - netAmount;
  if (Math.abs(charges - itemisedCharges) > TOLERANCE * kept.length) {
    return {
      error:
        `Finvasia column mismatch: obligation ${obligation.toFixed(2)} - final net ${netAmount.toFixed(2)} ` +
        `= ${charges.toFixed(2)}, but itemised charges sum to ${itemisedCharges.toFixed(2)}`,
    };
  }

  // Taxable value of supply = brokerage + transaction + SEBI + clearing + IPF.
  // A mismatch means the brokerage cell is probably not where we think it is.
  if (Math.abs(taxable - taxableComponents) > TOLERANCE * kept.length) {
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
    other_charges: round2(Math.abs(charges) - brokerage),
    skipped_segments: dropped,
  };
}

module.exports = { subject, extract };
