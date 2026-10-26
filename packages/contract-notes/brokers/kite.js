const Decimal = require('decimal.js');

// Zerodha (Kite) equity contract notes: the owner's Momentum account (BL-168 Phase 3; BL-142).
// Unlike the F&O brokers this reads the note's cash segment: Momentum buys and sells shares.
// The account trades nothing else, so an F&O figure on its note is refused, not guessed at.

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function searchSubject(accountId) {
  return `Combined Equity Contract Note for ${accountId}`;
}

// "22-10-2026-contract-notes_BZ1234.pdf" → '2026-10-22' (null if another account's file).
function noteDay({ filename, accountId }) {
  const m = new RegExp(
    `^(\\d{2})-(\\d{2})-(\\d{4})-contract-notes_${escapeRegExp(accountId)}\\.pdf$`,
    'i',
  ).exec(filename || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// "(7447.50)" is −7447.50: Zerodha prints what the client pays in brackets.
const AMOUNT = /\(?-?\d[\d,]*\.\d{2}\)?/g;

function amounts(text) {
  return [...String(text).matchAll(AMOUNT)].map((m) => {
    const raw = m[0];
    const n = new Decimal(raw.replace(/[(),]/g, ''));
    return raw.startsWith('(') ? n.negated() : n;
  });
}

// The totals block, one row per figure: label, then Cash, F&O and Net total (a blank F&O cell
// prints nothing, so a row has one to three amounts; the first is Cash, the last the Net total).
const ROWS = {
  obligation: /^Pay in\/Pay out obligation/i,
  brokerage: /^Taxable value of Supply \(Brokerage\)/i,
  exchange: /^Exchange transaction charges/i,
  clearing: /^Clearing charges/i,
  cgst: /^CGST/i,
  sgst: /^SGST/i,
  igst: /^IGST/i,
  stt: /^Securities transaction tax/i,
  sebi: /^SEBI turnover fees/i,
  stamp: /^Stamp duty/i,
  net: /^Net amount receivable/i,
};
const CHARGES = [
  'brokerage',
  'exchange',
  'clearing',
  'cgst',
  'sgst',
  'igst',
  'stt',
  'sebi',
  'stamp',
];
const TOLERANCE = 0.05;

function totalsBlock(text) {
  const start = text.search(/NCL-Cash\s*NCL-F&O\s*NET TOTAL/i);
  if (start === -1) return null;
  const rest = text.slice(start);
  const end = rest.search(/\n\s*1In the case of cross currency/i);
  return end === -1 ? rest : rest.slice(0, end);
}

/** { cash, fno } for each row of the totals block, as Decimals (missing = 0). */
function readTotals(block) {
  const lines = block.split('\n').map((l) => l.trim());
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const name = Object.keys(ROWS).find((k) => ROWS[k].test(lines[i]));
    if (!name) continue;
    // A footnote digit can sit between "(₹)" and the amounts ("(₹)2(0.01)"); it is followed by a
    // bracket or nothing. A receipt prints unbracketed ("(₹)5961.200.005961.20"): its first digit
    // is the amount's own.
    let tail = lines[i].replace(/^.*?\(₹\)/, '').replace(/^\d(?=\(|$)/, '');
    // The net amount's figures are on the next line.
    if (name === 'net' && amounts(tail).length === 0) tail = lines[i + 1] ?? '';
    const values = amounts(tail);
    const cash = values[0] ?? new Decimal(0);
    const fno = values.length === 3 ? values[1] : new Decimal(0);
    out[name] = { cash, fno };
  }
  return out;
}

/**
 * Trade rows of Annexure A. pdf-parse runs a row's cells together:
 * order no (16 digits on NSE, longer on BSE), order time, trade no, trade time, SYMBOL-SERIES/ISIN
 * (NSE "-EQ", BSE's group "-A" / "-B"; a symbol may start with digits, "20MICRONS"), B|S, exchange,
 * quantity and brokerage (glued: "120.0000" is 12 shares at 0.0000), net rate, net total.
 * The quantity/brokerage split is the one where quantity × rate = total.
 */
const TRADE =
  /^(\d+?)(\d{2}:\d{2}:\d{2})(\d+?)(\d{2}:\d{2}:\d{2})(.+?)\/(IN[A-Z0-9]{10})([BS])(NSE|BSE)(\d+\.\d{4})(\d+\.\d{2})(\(?[\d,]+\.\d{2}\)?)$/;
const TRADE_START = /^\d{10,}\d{2}:\d{2}:\d{2}\d+\d{2}:\d{2}:\d{2}/;

function readTrades(text) {
  const trades = [];
  const bad = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!TRADE_START.test(line)) continue;
    const m = TRADE.exec(line);
    if (!m) {
      bad.push(line.slice(0, 40));
      continue;
    }
    const [
      ,
      orderNo,
      orderTime,
      tradeNo,
      tradeTime,
      symbol,
      isin,
      side,
      exchange,
      qtyBrk,
      rate,
      totalRaw,
    ] = m;
    const total = amounts(totalRaw)[0].abs();
    const r = new Decimal(rate);
    const [whole, frac] = qtyBrk.split('.');
    let split = null;
    for (let k = 1; k < whole.length; k++) {
      const qty = new Decimal(whole.slice(0, k));
      if (qty.times(r).minus(total).abs().lte(0.05)) {
        split = { qty, brokerage: new Decimal(`${whole.slice(k)}.${frac}`) };
        break;
      }
    }
    if (!split) {
      bad.push(line.slice(0, 40));
      continue;
    }
    trades.push({
      order_no: orderNo,
      order_time: orderTime,
      trade_no: tradeNo,
      time: tradeTime,
      symbol: symbol.replace(/-(EQ|BE|[A-Z])$/, ''),
      isin,
      side: side === 'B' ? 'buy' : 'sell',
      exchange,
      qty: split.qty.toNumber(),
      price: r.toNumber(),
      value: total.toNumber(),
      brokerage: split.brokerage.toNumber(),
    });
  }
  return { trades, bad };
}

function extract(text) {
  if (!text) return { error: 'Kite extract received empty text' };
  const block = totalsBlock(text);
  if (!block) return { error: 'Kite totals block (NCL-Cash / NCL-F&O / NET TOTAL) not found' };
  const t = readTotals(block);
  if (!t.obligation || !t.net) return { error: 'Kite obligation or net amount row not found' };

  const fnoUsed = Object.values(t).some((v) => !v.fno.isZero());
  if (fnoUsed) {
    return {
      error:
        'Kite note has an F&O figure; this account is read as Momentum (equity) only — check the note and the account',
    };
  }

  const charges = {};
  let chargeSum = new Decimal(0);
  for (const name of CHARGES) {
    const v = (t[name]?.cash ?? new Decimal(0)).abs();
    charges[name] = v.toDecimalPlaces(2).toNumber();
    chargeSum = chargeSum.plus(v);
  }
  // obligation − charges must be the note's own net (both signed: payable is negative).
  const expected = t.obligation.cash.minus(chargeSum);
  if (expected.minus(t.net.cash).abs().greaterThan(TOLERANCE)) {
    return {
      error: `Kite column mismatch: obligation ${t.obligation.cash.toFixed(2)} − charges ${chargeSum.toFixed(2)} ≠ net ${t.net.cash.toFixed(2)}`,
    };
  }

  const { trades, bad } = readTrades(text);
  if (bad.length) return { error: `Kite trade row(s) not read: ${bad.join(' | ')}` };
  const traded = trades.reduce(
    (s, tr) => (tr.side === 'sell' ? s.plus(tr.value) : s.minus(tr.value)),
    new Decimal(0),
  );
  if (traded.minus(t.obligation.cash).abs().greaterThan(TOLERANCE)) {
    return {
      error: `Kite trades sum to ${traded.toFixed(2)} but the obligation is ${t.obligation.cash.toFixed(2)}`,
    };
  }

  return {
    eq: {
      payin_payout_obligation: t.obligation.cash.toDecimalPlaces(2).toNumber(),
      charges,
      total_charges: chargeSum.toDecimalPlaces(2).toNumber(),
      final_net: t.net.cash.toDecimalPlaces(2).toNumber(),
    },
    trades,
  };
}

module.exports = { searchSubject, noteDay, extract };
