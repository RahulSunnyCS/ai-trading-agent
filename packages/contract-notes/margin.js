const fs = require('node:fs');
const path = require('node:path');
const Decimal = require('decimal.js');
const { writeDurable } = require('./store');

// The brokers' daily margin statements (BL-205): what each account had as margin at the end of a
// session, and (Angel One) the most the exchange asked of it during the session. One reader per
// broker, matched by subject, sender and the PDF's file name; each statement is one line per
// account in margin/<day>.jsonl (the statement's trade date), the PDF kept encrypted beside the
// notes. Every figure is checked against the statement's own arithmetic before it is stored: a
// changed layout fails loudly instead of storing a wrong figure.

/**
 * The columns of the statements' margin table, as SEBI's format numbers them:
 * A funds, B securities (after haircut), C margin-pledged securities (after haircut), D bank
 * guarantees / FDR, E any other approved form; F = A+B+C+D+E the margin available; G the total
 * upfront margin, H the consolidated crystallised obligation / MTM, I delivery margin; J = G+H+I
 * the total requirement; K = F−J the excess or shortfall; L the member's additional margin (RMS);
 * M = K−L the margin status.
 */
const COLUMNS = [
  'funds',
  'securities',
  'pledged',
  'bank_guarantee',
  'other',
  'available',
  'upfront',
  'crystallised',
  'delivery',
  'requirement',
  'excess',
  'rms_additional',
  'status',
];

const TOLERANCE = new Decimal('0.02');
const dec = (text) => new Decimal(String(text).replace(/,/g, ''));
const num = (d) => d.toDecimalPlaces(2).toNumber();
const close = (a, b) => a.minus(b).abs().lte(TOLERANCE);

/** The table's own sums; the first that does not hold, or null. */
function arithmetic(row) {
  const v = Object.fromEntries(COLUMNS.map((c) => [c, row[c]]));
  if (
    !close(Decimal.sum(v.funds, v.securities, v.pledged, v.bank_guarantee, v.other), v.available)
  ) {
    return 'available is not funds + securities + pledged + guarantees + other';
  }
  if (!close(Decimal.sum(v.upfront, v.crystallised, v.delivery), v.requirement)) {
    return 'requirement is not upfront + crystallised + delivery';
  }
  if (!close(v.available.minus(v.requirement), v.excess)) {
    return 'excess is not available − requirement';
  }
  if (!close(v.excess.minus(v.rms_additional), v.status)) return 'status is not excess − RMS';
  return null;
}

const asNumbers = (row) => Object.fromEntries(COLUMNS.map((c) => [c, num(row[c])]));

/**
 * Angel One's "DAILY MARGIN STATEMENT FOR THE DAY": one row per segment (NSE-F&O, EQUITY,
 * MCX-F&O, NCE-F&O, EPN-EPN early pay-in, …) and a Total, thirteen figures each. pdf-parse runs
 * a row's cells together (`0.000.000.00740577.82`) and wraps one number over two lines
 * (`104343.` / `81`); every figure has exactly two decimals, which splits them.
 */
function parseAngelone(text) {
  const day = /DAILY MARGIN STATEMENT FOR THE DAY\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(text);
  if (!day) return { error: 'no "DAILY MARGIN STATEMENT FOR THE DAY" date' };
  const account = /Client Code\s*:\s*([A-Z0-9]+)/i.exec(text);
  const table =
    /K=\(F-J\)LM=\(K-L\)\s*\n([\s\S]*?)(?:\nCollateral Details|\n\*Approved form|$)/.exec(text);
  if (!table) return { error: 'no margin table (the column header "K=(F-J)LM=(K-L)")' };
  const body = table[1].replace(/\s*\n\s*/g, '');
  const tokens = [];
  const re = /(Total|[A-Z][A-Z&]*(?:-[A-Z&]+)*)|(-?\d+\.\d{2})|(\S)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[3]) return { error: `margin table: unexpected "${body.slice(m.index, m.index + 12)}"` };
    tokens.push(m[1] ? { label: m[1] } : { value: dec(m[2]) });
  }
  const rows = {};
  for (let i = 0; i < tokens.length; ) {
    const label = tokens[i].label;
    if (!label) return { error: 'margin table: a figure with no segment before it' };
    const values = [];
    for (i += 1; i < tokens.length && tokens[i].value; i += 1) values.push(tokens[i].value);
    if (values.length !== COLUMNS.length) {
      return { error: `margin table: ${label} has ${values.length} figures, not 13` };
    }
    if (rows[label]) return { error: `margin table: ${label} twice` };
    rows[label] = Object.fromEntries(COLUMNS.map((c, j) => [c, values[j]]));
    const bad = arithmetic(rows[label]);
    if (bad) return { error: `margin table: ${label}: ${bad}` };
  }
  const total = rows.Total;
  if (!total) return { error: 'margin table: no Total row' };
  const segments = Object.keys(rows).filter((k) => k !== 'Total');
  for (const c of COLUMNS) {
    const sum = segments.reduce((s, k) => s.plus(rows[k][c]), new Decimal(0));
    if (!close(sum, total[c])) return { error: `margin table: the segments' ${c} do not add up` };
  }
  const holdings = angelHoldings(text);
  if (holdings.error) return holdings;
  const held = holdings.list.reduce((s, h) => s.plus(h.value), new Decimal(0));
  if (holdings.list.length && !close(held, total.securities.plus(total.pledged))) {
    return { error: 'collateral: the scrips do not add up to the securities in the table' };
  }
  return {
    day: `${day[3]}-${day[2]}-${day[1]}`,
    account: account?.[1] ?? null,
    total: asNumbers(total),
    segments: Object.fromEntries(segments.map((k) => [k, asNumbers(rows[k])])),
    holdings: holdings.list.map(holdingNumbers),
  };
}

// A scrip's series after its name, as Angel One prints it glued (`…LTDEQ`).
const SERIES = /(EQ|BE|BZ|GB|GS|TB|SG|N[0-9A-Z])$/;

/**
 * Angel One's "Collateral Details": `<sr><ISIN>-<name><series><qty><rate><value><haircut%>
 * <after haircut><account>`, every cell glued. Read from the right: the account word, then four
 * two-decimal figures, the first glued to the quantity, which is where quantity × rate = value.
 */
function angelHoldings(text) {
  const section = /Collateral Details :-\s*\nSecurities :\s*\n[^\n]*\n([\s\S]*?)\nTotal/.exec(text);
  if (!section) return { list: [] };
  const list = [];
  for (const line of section[1].split('\n').filter((l) => l.trim())) {
    const m = /^\d+(IN[A-Z0-9]{10})-(.*?)([A-Z][A-Z ]*)$/.exec(line.trim());
    if (!m) return { error: `collateral: a row that does not read: "${line.slice(0, 40)}"` };
    const [, isin, middle, account] = m;
    const tail = /(\d+\.\d{2})(\d+\.\d{2})(\d+\.\d{2})(\d+\.\d{2})$/.exec(middle);
    if (!tail) return { error: `collateral: ${isin}: no figures` };
    // The leftmost match starts at the quantity: the name and series end in a letter.
    const head = middle.slice(0, tail.index);
    const [, glued, valueText, haircutText, afterText] = tail;
    const [digits, rateDec] = glued.split('.');
    const value = dec(valueText);
    const splits = [];
    for (let k = 1; k < digits.length; k += 1) {
      const qty = new Decimal(digits.slice(0, k));
      const rate = new Decimal(`${digits.slice(k)}.${rateDec}`);
      if (qty.gt(0) && qty.times(rate).minus(value).abs().lte(qty.times('0.005').plus('0.01'))) {
        splits.push({ qty, rate });
      }
    }
    if (splits.length !== 1) {
      return { error: `collateral: ${isin}: quantity and rate cannot be told apart` };
    }
    const { qty, rate } = splits[0];
    const series = SERIES.exec(head);
    list.push({
      isin,
      name: (series ? head.slice(0, -series[1].length) : head).trim(),
      series: series ? series[1] : null,
      quantity: qty,
      close: rate,
      haircut_pct: dec(haircutText),
      value: dec(afterText),
      account: account.trim(),
    });
  }
  return { list };
}

function holdingNumbers(h) {
  return {
    isin: h.isin,
    name: h.name,
    ...(h.series !== undefined ? { series: h.series } : {}),
    quantity: h.quantity.toNumber(),
    close: num(h.close),
    haircut_pct: num(h.haircut_pct),
    value: num(h.value),
    ...(h.account ? { account: h.account } : {}),
  };
}

/**
 * Finvasia's "Daily Margin Report of Trade Date": the same columns, but pdf-parse prints the
 * Total row out of order over two lines: [A, K, B, D, E-other, F, G, J, K, L] then, after the
 * word "Total", [C, H, I]. Checked against the statement's own sums, its "Net Funds" and its
 * "Total Holding Value", so a moved column is refused.
 */
function parseFinvasia(text) {
  const day = /Daily Margin Report of Trade Date\s*(\d{2})\s*-\s*(\d{2})\s*-\s*(\d{4})/i.exec(text);
  if (!day) return { error: 'no "Daily Margin Report of Trade Date"' };
  const account = /^([A-Z]{2}\d+)\s*\n\s*Account ID/m.exec(text);
  const lines = text.split('\n');
  const figures = (l) => (l.match(/-?[\d,]+\.\d{2}/g) ?? []).map(dec);
  // The header's column titles say "Total" too; the row's is the one after its figures.
  const at = lines.findIndex(
    (l, i) => l.trim() === 'Total' && i > 0 && figures(lines[i - 1]).length,
  );
  if (at < 1) return { error: 'no Total row' };
  const first = figures(lines[at - 1]);
  let j = at + 1;
  while (j < lines.length && !figures(lines[j]).length) j += 1;
  const second = j < lines.length ? figures(lines[j]) : [];
  if (first.length !== 10 || second.length !== 3) {
    return { error: `Total row: ${first.length} + ${second.length} figures, not 10 + 3` };
  }
  const [funds, excessAgain, securities, bankGuarantee, other] = first;
  const [available, upfront, requirement, excess, rmsAdditional] = first.slice(5);
  const [pledged, crystallised, delivery] = second;
  const total = {
    funds,
    securities,
    pledged,
    bank_guarantee: bankGuarantee,
    other,
    available,
    upfront,
    crystallised,
    delivery,
    requirement,
    excess,
    rms_additional: rmsAdditional,
    status: excess.minus(rmsAdditional),
  };
  const bad = arithmetic(total);
  if (bad) return { error: `Total row: ${bad}` };
  if (!close(excessAgain, excess)) return { error: 'Total row: the two excess figures differ' };
  const netFunds = /Net Funds\s*\n([^\n]*)/.exec(text);
  const net = netFunds ? figures(netFunds[1]).at(-1) : null;
  if (net && !close(net, funds)) return { error: 'Total row: funds differ from "Net Funds"' };
  const list = [];
  const rowRe = /^(IN[A-Z0-9]{10})(.+?) (\d+) ([\d,]+\.\d{2}) ([\d,]+\.\d{2}) ([\d,]+\.\d{2})$/gm;
  for (let m = rowRe.exec(text); m; m = rowRe.exec(text)) {
    list.push({
      isin: m[1],
      name: m[2].trim(),
      quantity: new Decimal(m[3]),
      close: dec(m[4]),
      haircut_pct: dec(m[5]),
      value: dec(m[6]),
    });
  }
  const held = list.reduce((s, h) => s.plus(h.value), new Decimal(0));
  const holdingValue = /\n\s*([\d,]+\.\d{2})\s*\nTotal Holding Value/.exec(text);
  if (holdingValue && !close(dec(holdingValue[1]), held)) {
    return { error: 'holdings: the scrips do not add up to "Total Holding Value"' };
  }
  if (!close(held, pledged.plus(securities))) {
    return { error: 'holdings: the scrips do not add up to the collateral in the Total row' };
  }
  return {
    day: `${day[3]}-${day[2]}-${day[1]}`,
    account: account?.[1] ?? null,
    total: asNumbers(total),
    segments: null,
    holdings: list.map(holdingNumbers),
  };
}

/**
 * Each broker's statement: the IMAP subject, the sender's domain, the PDF's name (the account and
 * the trade date, DDMMYYYY) and the parser. A statement for an account not configured in the
 * mailbox is skipped (the owner's other accounts).
 */
const STATEMENTS = [
  {
    broker: 'angelone',
    subject: 'Margin Statement for the day',
    from: 'angeltrade.in',
    file: /^CM_([A-Z0-9]+)_(\d{2})(\d{2})(\d{4})\.pdf$/i,
    parse: parseAngelone,
  },
  {
    broker: 'finvasia',
    subject: 'Client Margin Report',
    from: 'shoonya.com',
    file: /^MARGIN_([A-Z0-9]+)_(\d{2})(\d{2})(\d{4})\.pdf$/i,
    parse: parseFinvasia,
  },
];

/** { account, day } from a statement PDF's name, or null. */
function fileInfo(statement, filename) {
  const m = statement.file.exec(String(filename ?? ''));
  return m ? { account: m[1], day: `${m[4]}-${m[3]}-${m[2]}` } : null;
}

function fromOk(statement, from) {
  const sender = String(from ?? '').toLowerCase();
  return sender.endsWith(`@${statement.from}`) || sender.endsWith(`.${statement.from}`);
}

function marginFile(root, day) {
  return path.join(root, 'margin', `${day}.jsonl`);
}

/** Every statement stored for `day`. */
function readMarginDay(root, day) {
  try {
    return fs
      .readFileSync(marginFile(root, day), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Store one account's statement for its day, replacing the account's earlier line (atomic). */
function writeStatement(root, line) {
  const file = marginFile(root, line.day);
  const others = readMarginDay(root, line.day).filter(
    (l) => !(l.broker === line.broker && l.account === line.account),
  );
  others.push(line);
  others.sort((a, b) => `${a.broker}/${a.account}`.localeCompare(`${b.broker}/${b.account}`));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeDurable(file, `${others.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** Keep the encrypted statement: raw/<broker>/<account>/margin/<day>.pdf. */
function saveRawStatement(root, broker, account, day, content) {
  const dir = path.join(root, 'raw', broker, account, 'margin');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${day}.pdf`);
  writeDurable(file, content);
  return file;
}

module.exports = {
  COLUMNS,
  STATEMENTS,
  fileInfo,
  fromOk,
  marginFile,
  parseAngelone,
  parseFinvasia,
  readMarginDay,
  saveRawStatement,
  writeStatement,
};
