const Decimal = require('decimal.js');
const logger = require('../utils/logger');

// The F&O notes' trade summary (BL-168 Phase 3): one row per contract and side, with the
// quantity, the weighted average price (WAP), brokerage per unit, the WAP after brokerage and the
// net total. Both brokers print it; the layouts differ.

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const TOLERANCE = new Decimal('0.05');

const dec = (s) => new Decimal(String(s).replace(/,/g, ''));
const num = (d) => d.toDecimalPlaces(4).toNumber();

function isoDay(dd, mon, yyyy) {
  const m = MONTHS.indexOf(mon.slice(0, 3).toUpperCase());
  return m < 0 ? null : `${yyyy}-${String(m + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** "OPTIDX NIFTY 27OCT2026 22400.00 PE" / "OPTIDX NIFTY Oct 27 2026 22400.00 PE" → fields. */
function contract({ instrument, underlying, expiry, strike, kind }) {
  return {
    instrument,
    underlying,
    expiry,
    strike: strike == null ? null : num(dec(strike)),
    kind: kind ?? (instrument.startsWith('FUT') ? 'FUT' : null),
  };
}

/**
 * Finvasia: "FNO OPTIDX NIFTY 27OCT2026 22400.00 PEB 75.00 0.00 40.00 0.0800 40.08 0.00-3006.00"
 * = segment, instrument, underlying, expiry, strike, CE|PE + B|S, quantity, WAP (foreign
 * currency), WAP, brokerage per unit, WAP after brokerage, closing rate, net total.
 */
const FINVASIA_ROW =
  /^\s*FNO\s+(OPT|FUT)(IDX|STK)\s+([A-Z&-]+)\s+(\d{2})([A-Z]{3})(\d{4})\s+(?:([\d.]+)\s+(CE|PE))?\s*(B|S)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(-?[\d,]+\.\d{2})\s*$/;

function finvasiaTrades(text) {
  const trades = [];
  const bad = [];
  for (const line of text.split('\n')) {
    if (!/^\s*FNO\s+(OPT|FUT)/.test(line)) continue;
    const m = FINVASIA_ROW.exec(line);
    if (!m) {
      bad.push(line.trim().slice(0, 40));
      continue;
    }
    const [
      ,
      oi,
      kindOfIdx,
      und,
      dd,
      mon,
      yyyy,
      strike,
      cepe,
      side,
      qty,
      ,
      wap,
      brk,
      wapAfter,
      ,
      total,
    ] = m;
    trades.push({
      ...contract({
        instrument: `${oi}${kindOfIdx}`,
        underlying: und,
        expiry: isoDay(dd, mon, yyyy),
        strike: strike ?? null,
        kind: cepe ?? null,
      }),
      side: side === 'B' ? 'buy' : 'sell',
      qty: num(dec(qty)),
      wap: num(dec(wap)),
      brokerage_per_unit: num(dec(brk)),
      wap_after_brokerage: num(dec(wapAfter)),
      net_total: num(dec(total)),
    });
  }
  return { trades, bad };
}

/**
 * Angel One: "OPTIDX NIFTY Oct 27 2026 22400.00  PE(BT)SELL7540.000.000040.000.003000.00" —
 * the cells after the side run together: quantity, WAP, brokerage per unit (4 decimals), WAP
 * after brokerage, closing rate, net total. Quantity and WAP are split where quantity × WAP after
 * brokerage = |net total|.
 */
const ANGEL_LEAD = /^\s*(OPT|FUT)(IDX|STK)\s+[A-Z&-]+\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{4}/;

function angelTrades(text) {
  const trades = [];
  const bad = [];
  for (const line of text.split('\n')) {
    if (!ANGEL_LEAD.test(line)) continue;
    // The quantity has no decimals and runs into the WAP: read the cells after the side whole.
    const head =
      /^\s*(OPT|FUT)(IDX|STK)\s+([A-Z&-]+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(?:([\d.]+)\s+(CE|PE))?\s*(?:\([A-Z]+\))?\s*(BUY|SELL)(.*)$/.exec(
        line,
      );
    const cells =
      head &&
      /^(\d+\.\d{2})(\d+\.\d{4})(\d+\.\d{2})(\d+\.\d{2})(-?[\d,]+\.\d{2})\s*$/.exec(head[10]);
    if (!cells) {
      bad.push(line.trim().slice(0, 40));
      continue;
    }
    const [, oi, kindOfIdx, und, mon, dd, yyyy, strike, cepe, side] = head;
    const [, qtyWap, brk, wapAfter, , total] = cells;
    const after = dec(wapAfter);
    const net = dec(total);
    // The WAP (2 decimals) is the WAP after brokerage give or take the brokerage per unit; the
    // total can miss qty × WAP by the WAP's rounding when a contract had several fills.
    const glued = splitGlued(qtyWap, {
      netRate: after,
      places: 2,
      total: net,
      expectRate: after,
      rateSlack: dec(brk).plus('0.01'),
    });
    const split = glued && { qty: glued.qty, wap: glued.rate };
    if (!split) {
      bad.push(line.trim().slice(0, 40));
      continue;
    }
    trades.push({
      ...contract({
        instrument: `${oi}${kindOfIdx}`,
        underlying: und,
        expiry: isoDay(dd, mon, yyyy),
        strike: strike ?? null,
        kind: cepe ?? null,
      }),
      side: side === 'BUY' ? 'buy' : 'sell',
      qty: num(split.qty),
      wap: num(split.wap),
      brokerage_per_unit: num(dec(brk)),
      wap_after_brokerage: num(after),
      net_total: num(net),
    });
  }
  return { trades, bad };
}

// The contract as the annexures print it, possibly over two lines ("… Oct 27 2026" / "22400.00
// PE (BT)"), joined with spaces first.
const CONTRACT =
  /(OPT|FUT)(IDX|STK)\s+([A-Z&-]+)\s+(?:(\d{1,2})\s*([A-Za-z]{3})\s*(\d{4})|([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4}))(?:\s+([\d.]+)\s+(CE|PE))?/;

function readContract(text) {
  const m = CONTRACT.exec(text.replace(/\s+/g, ' '));
  if (!m) return null;
  const [, oi, kindOfIdx, und, d1, mon1, y1, mon2, d2, y2, strike, cepe] = m;
  return contract({
    instrument: `${oi}${kindOfIdx}`,
    underlying: und,
    expiry: d1 ? isoDay(d1, mon1, y1) : isoDay(d2, mon2, y2),
    strike: strike ?? null,
    kind: cepe ?? null,
  });
}

/**
 * Split a glued "<qty><rate>" cell. The quantity has no decimals and a rate's whole part never
 * starts with 0 (bar "0.xx"), so each split point is one candidate. The right one has the rate
 * within `rateSlack` of `expectRate` (when given) and qty × `netRate` equal to |total| within the
 * rounding of a rate printed to `places` decimals: half a unit of its last place per unit, plus
 * the usual paise.
 */
function splitGlued(glued, { netRate, places, total, expectRate = null, rateSlack = dec(0) }) {
  const [whole, frac] = glued.split('.');
  const half = dec(1).div(dec(10).pow(places)).div(2);
  for (let k = 1; k < whole.length; k++) {
    const rateWhole = whole.slice(k);
    if (rateWhole.length > 1 && rateWhole.startsWith('0')) continue;
    const qty = dec(whole.slice(0, k));
    const rate = dec(`${rateWhole}.${frac}`);
    if (expectRate && rate.minus(expectRate).abs().gt(rateSlack)) continue;
    const slack = TOLERANCE.plus(qty.times(half));
    if (qty.times(netRate).minus(total.abs()).abs().lte(slack)) return { qty, rate };
  }
  return null;
}

const TIMES = /^(\d{10,})(\d{2}:\d{2}:\d{2})(\d+?)(\d{2}:\d{2}:\d{2})$/;

/**
 * Angel One's annexure, one fill per block:
 *   "<order no><hh:mm:ss><trade no><hh:mm:ss>"
 *   the contract, over one or two lines
 *   "SELL7540.00000.000040.00000.00003000.0000" = side, quantity, rate, brokerage per unit,
 *   net rate, closing rate, net total (4 decimals each; quantity and rate run together).
 */
function angelFills(text) {
  const lines = text.split('\n').map((l) => l.trim());
  const fills = [];
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const t = TIMES.exec(lines[i]);
    if (!t) continue;
    let j = i + 1;
    const parts = [];
    while (j < lines.length && j <= i + 4 && !/^(BUY|SELL)\d/.test(lines[j]))
      parts.push(lines[j++]);
    const c = readContract(parts.join(' '));
    const v = /^(BUY|SELL)(\d+\.\d{4})(\d+\.\d{4})(\d+\.\d{4})(\d+\.\d{4})(-?[\d,]+\.\d{4})$/.exec(
      lines[j] ?? '',
    );
    if (!c || !v) {
      if (c || v) bad.push(`${(lines[j] ?? '').slice(0, 30)}`);
      continue;
    }
    // v: side, quantity+rate, brokerage per unit, net rate, closing rate, net total.
    const net = dec(v[6]);
    const split = splitGlued(v[2], {
      netRate: dec(v[4]),
      places: 4,
      total: net,
      expectRate: dec(v[4]),
      rateSlack: dec(v[3]).plus('0.0001'),
    });
    if (!split) {
      bad.push(lines[j].slice(0, 30));
      continue;
    }
    fills.push({
      ...c,
      side: v[1] === 'BUY' ? 'buy' : 'sell',
      qty: num(split.qty),
      price: num(split.rate),
      brokerage_per_unit: num(dec(v[3])),
      net_price: num(dec(v[4])),
      // The annexure prints the total unsigned: a buy is paid.
      net_total: num(v[1] === 'BUY' ? net.abs().negated() : net.abs()),
      order_no: t[1],
      order_time: t[2],
      trade_no: t[3],
      time: t[4],
    });
    i = j;
  }
  return { trades: fills, bad };
}

/**
 * Finvasia's annexure, one fill per block:
 *   "<order no><trade no>B|S"
 *   " 150 30.0000 0.0400 30.0400-4506.00OPTIDX NIFTY 24JUL2025 25200.00 CE" (quantity, rate,
 *   brokerage per unit, net rate, net total, then the contract — which may wrap)
 *   "<hh:mm:ss><hh:mm:ss>" (order time, trade time)
 */
function finvasiaFills(text) {
  const lines = text.split('\n');
  const fills = [];
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const id = /^\s*(\d{10,})([BS])\s*$/.exec(lines[i]);
    if (!id) continue;
    let j = i + 1;
    const parts = [];
    while (
      j < lines.length &&
      j <= i + 4 &&
      !/^\s*\d{2}:\d{2}:\d{2}\d{2}:\d{2}:\d{2}\s*$/.test(lines[j])
    )
      parts.push(lines[j++]);
    const body = parts.join(' ');
    const v = /^\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(-?[\d,]+\.\d{2})\s*(.*)$/.exec(
      body,
    );
    const c = v && readContract(v[6]);
    const times = /(\d{2}:\d{2}:\d{2})(\d{2}:\d{2}:\d{2})/.exec(lines[j] ?? '');
    if (!v || !c || !times) {
      if (v || c) bad.push(body.trim().slice(0, 30));
      continue;
    }
    fills.push({
      ...c,
      side: id[2] === 'B' ? 'buy' : 'sell',
      qty: num(dec(v[1])),
      price: num(dec(v[2])),
      brokerage_per_unit: num(dec(v[3])),
      net_price: num(dec(v[4])),
      net_total: num(dec(v[5])),
      order_no: id[1],
      order_time: times[1],
      time: times[2],
    });
    i = j;
  }
  return { trades: fills, bad };
}

/** Sum of the rows' net totals (sells received, buys paid), for the cross-check. */
const netOf = (trades) => trades.reduce((s, t) => s.plus(t.net_total), new Decimal(0));

/**
 * The note's trades for the store: the annexure's fills when they add up to the note's F&O
 * obligation (they carry times), else the summary's rows when those do, else whatever was read,
 * marked `unmatched` (a layout not read yet). A note never fails over its trades.
 */
function chooseTrades(text, broker, obligation) {
  try {
    const [fills, summary] =
      broker === 'finvasia'
        ? [finvasiaFills(text), finvasiaTrades(text)]
        : [angelFills(text), angelTrades(text)];
    const adds = (r) => r.trades.length > 0 && netOf(r.trades).minus(obligation).abs().lte(1);
    if (adds(fills)) return { trades: fills.trades, trades_check: 'fills' };
    if (adds(summary)) return { trades: summary.trades, trades_check: 'summary' };
    const best = fills.trades.length >= summary.trades.length ? fills : summary;
    logger.warn('trades do not add up to the note', {
      broker,
      read: best.trades.length,
      unread: best.bad.length,
    });
    return { trades: best.trades, trades_check: 'unmatched', trades_unread: best.bad.length };
  } catch (err) {
    // A row the readers did not foresee: the note's figures still stand.
    logger.warn('trades could not be read', { broker, error: err.message });
    return { trades: [], trades_check: 'unmatched', trades_error: err.message };
  }
}

module.exports = {
  finvasiaTrades,
  angelTrades,
  finvasiaFills,
  angelFills,
  netOf,
  readContract,
  chooseTrades,
};
