const { isTotalRow, parseAmounts, splitBySegment } = require('./segments');
const logger = require('../utils/logger');

// Column order of the "Obligation Details" table, one row per exchange/segment.
const COL = {
  OBLIGATION: 0, // Pay In/Pay Out Obligation (already net of brokerage)
  STT: 1,
  TAXABLE: 2, // Taxable value of supply = brokerage + txn charges + SEBI fees + IPF
  CGST: 3,
  SGST: 4,
  EXCHANGE_TXN: 5,
  SEBI: 6,
  STAMP: 7,
  IPF: 8,
  AUCTION_OTHER: 9,
  NET: 10, // Net Amount Receivable by / (Payable by) Client
};
const COLUMN_COUNT = 11;
const CHARGE_COLS = [
  COL.STT,
  COL.CGST,
  COL.SGST,
  COL.EXCHANGE_TXN,
  COL.SEBI,
  COL.STAMP,
  COL.IPF,
  COL.AUCTION_OTHER,
];
const TOLERANCE = 0.05;

// Each obligation row sits on its own line with the label glued to the first
// amount, e.g. "BSE-FUTURES-3809.0099.00284.35...-4005.53".
const ROW_LINE = new RegExp(
  `^\\s*([A-Za-z][A-Za-z0-9&()/. -]*?)\\s*((?:-?\\d+(?:,\\d{3})*\\.\\d{2}){${COLUMN_COUNT}})\\s*$`,
);

function subject() {
  return 'Contract Note - Equity Segment';
}

function bodyFilter(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function obligationBlock(text) {
  const start = text.search(/Obligation\s+Details/i);
  if (start === -1) return null;
  const rest = text.slice(start);
  const endMatch = rest.match(/Total\s+Brokerage\s*=|Taxable\s+Value\s+of\s+Supply\s+Includes/i);
  return endMatch ? rest.slice(0, endMatch.index) : rest;
}

// The note reports brokerage only as a single all-segment "Total Brokerage"
// figure, but it also states that taxable value of supply = brokerage +
// exchange transaction charges + SEBI turnover fees + IPF charges. Inverting
// that gives this segment's own brokerage.
function segmentBrokerage(a) {
  return a[COL.TAXABLE] - a[COL.EXCHANGE_TXN] - a[COL.SEBI] - a[COL.IPF];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function parseRows(block) {
  const rows = [];
  for (const line of block.split('\n')) {
    const m = line.match(ROW_LINE);
    if (!m) continue;
    const amounts = parseAmounts(m[2]);
    if (amounts.length !== COLUMN_COUNT) continue;
    rows.push({ label: m[1].trim(), amounts });
  }
  return rows;
}

function extract(text) {
  if (!text) return { error: 'Angel One extract received empty text' };

  const block = obligationBlock(text);
  if (!block) {
    const snippet = text.slice(0, 500).replace(/\n/g, ' ');
    return { error: `Angel One Obligation Details table not found. Text preview: ${snippet}` };
  }

  const rows = parseRows(block);
  if (!rows.length) {
    const snippet = block.slice(0, 500).replace(/\n/g, ' ');
    return {
      error: `Angel One Obligation Details rows not matched (expected ${COLUMN_COUNT} amounts per row). Text preview: ${snippet}`,
    };
  }

  const { kept, dropped, unknown } = splitBySegment(rows);
  // Only the all-segment summary row parsed: the per-segment rows are there in
  // the PDF, so this is a layout change, not a note without F&O activity.
  if (!kept.length && !dropped.length && !unknown.length) {
    return {
      error: `Angel One Obligation Details contains no per-segment rows, only summary row(s): ${rows
        .map((r) => r.label)
        .join(', ')}`,
    };
  }
  if (unknown.length) {
    return {
      error:
        `Angel One obligation row(s) with unrecognised segment: ${unknown.join(', ')}. ` +
        `Add the label to brokers/segments.js so it is classified as F&O or excluded.`,
    };
  }

  // Every row was cash / currency / commodity: no F&O activity to record.
  if (!kept.length) {
    logger.info('Angel One note has no F&O segment — recording zeros', {
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

  for (const row of kept) {
    const a = row.amounts;
    if (a.some((n) => !Number.isFinite(n))) {
      return { error: `Angel One row "${row.label}" contains a non-numeric amount` };
    }
    obligation += a[COL.OBLIGATION];
    netAmount += a[COL.NET];
    brokerage += segmentBrokerage(a);
    itemisedCharges += CHARGE_COLS.reduce((sum, c) => sum + a[c], 0);
  }

  // obligation - charges must land on the note's own net amount; if it does
  // not, the columns were read in the wrong order and the numbers are unsafe.
  const charges = obligation - netAmount;
  if (Math.abs(charges - itemisedCharges) > TOLERANCE * kept.length) {
    return {
      error:
        `Angel One column mismatch: obligation ${obligation.toFixed(2)} - net ${netAmount.toFixed(2)} ` +
        `= ${charges.toFixed(2)}, but itemised charges sum to ${itemisedCharges.toFixed(2)}`,
    };
  }

  // "Total Brokerage" covers every segment, so it only cross-checks the
  // derivation when it is compared against all rows.
  const totalBrokerageMatch = text.match(/Total\s+Brokerage\s*=\s*(-?\d+(?:,\d{3})*\.\d{2})/i);
  if (totalBrokerageMatch) {
    const allRowsBrokerage = rows
      .filter((r) => !isTotalRow(r.label))
      .reduce((sum, r) => sum + segmentBrokerage(r.amounts), 0);
    const reported = Number.parseFloat(totalBrokerageMatch[1].replace(/,/g, ''));
    if (Math.abs(allRowsBrokerage - reported) > TOLERANCE * rows.length) {
      logger.warn('Angel One derived brokerage does not match reported Total Brokerage', {
        derived: allRowsBrokerage.toFixed(2),
        reported: reported.toFixed(2),
      });
    }
  }

  if (dropped.length) {
    logger.info('Angel One non-F&O segments excluded', { segments: dropped.join(', ') });
  }

  return {
    // Angel One's obligation already has brokerage deducted; add it back for a consistent raw P&L
    payin_payout_obligation: round2(obligation + brokerage),
    net_brokerage: round2(brokerage),
    other_charges: round2(Math.abs(charges)),
    skipped_segments: dropped,
  };
}

module.exports = { subject, bodyFilter, extract };
