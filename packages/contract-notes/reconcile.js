const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const Decimal = require('decimal.js');
const { loadBrokerAccounts } = require('./brokers');
const { istNow } = require('./calendar');
const { readDay, storeRoot } = require('./store');

// The owner's Google Sheet against the stored notes (BL-168 Phase 3). Reads a CSV export of the
// sheet's first tab (File › Download › CSV, or the Drive connector), compares each day's net per
// broker with the notes, and writes a report the owner explains line by line. With
// --import-manual it also stores the two columns the sheet had typed by hand (Algos, Capital) as
// manual/<day>.json. It never writes the sheet.
//
//   node reconcile.js <sheet.csv> [--import-manual] [--out DIR]
//
// The sheet's columns, by header: Sell Algo / Brokerage / Other (Angel One) and Sell Algo /
// Brokerage / Other charge (Mummy = Finvasia). A day's net is obligation − brokerage − other.
// Every Finvasia account in BROKER_ACCOUNTS_JSON counts towards the sheet's one Finvasia block.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TOLERANCE = 1; // rupees: the sheet keeps some figures rounded

/** A minimal RFC 4180 reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** "1-Apr-25", "28 Apr 25", "Sept" too → 'YYYY-MM-DD'; null if it is not a date. */
function sheetDay(text) {
  const p = String(text || '')
    .trim()
    .split(/[\s-]+/);
  if (p.length !== 3) return null;
  const month = MONTHS.findIndex((m) => m.toLowerCase() === p[1].slice(0, 3).toLowerCase());
  const d = Number(p[0]);
  const y = 2000 + Number(p[2]);
  if (month < 0 || !d || !Number.isFinite(y)) return null;
  return `${y}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A sheet cell as a Decimal; blank, "N/A" and "-" read as zero, and say so. */
function cell(text) {
  const t = String(text ?? '')
    .replace(/,/g, '')
    .trim();
  if (!t || t === 'N/A' || t === '-') return { value: new Decimal(0), blank: true };
  try {
    return { value: new Decimal(t), blank: false };
  } catch {
    return { value: new Decimal(0), blank: true };
  }
}

function columns(header) {
  const find = (re) => header.findIndex((h) => re.test(h));
  const cols = {
    date: find(/^Date$/i),
    algos: find(/^Algos$/i),
    capital: find(/^Capital$/i),
    angel: [
      find(/Sell Algo\s*\(Angel/i),
      find(/Brokerage\s*\(Angel/i),
      find(/Other Charges?\s*\(Angel/i),
    ],
    finvasia: [find(/Sell Algo\s*\(Mummy/i), find(/Brokerage\s*\(Mummy/i), find(/^Other charge$/i)],
  };
  const missing = [
    ['Date', cols.date],
    ['Sell Algo(Angel One)', cols.angel[0]],
    ['Sell Algo(Mummy)', cols.finvasia[0]],
  ].filter(([, i]) => i < 0);
  if (missing.length) {
    throw new Error(
      `the CSV has no column ${missing.map(([n]) => `"${n}"`).join(', ')} — is it the Trade Book tab?`,
    );
  }
  return cols;
}

/** The sheet's rows as { day, angel, finvasia, algos, capital, blankAngel, blankFinvasia }. */
function sheetRows(csvText) {
  const [header, ...rest] = parseCsv(csvText);
  const cols = columns(header);
  const out = [];
  for (const r of rest) {
    const day = sheetDay(r[cols.date]);
    if (!day) continue;
    const net = (idx) => {
      const [obl, brk, oth] = idx.map((i) => cell(r[i]));
      return { value: obl.value.minus(brk.value).minus(oth.value), blank: obl.blank };
    };
    const a = net(cols.angel);
    const f = net(cols.finvasia);
    out.push({
      day,
      angel: a.value,
      finvasia: f.value,
      blankAngel: a.blank,
      blankFinvasia: f.blank,
      algos: cols.algos >= 0 ? cell(r[cols.algos]) : null,
      capital: cols.capital >= 0 ? cell(r[cols.capital]) : null,
    });
  }
  return out;
}

/** The stored notes' final net per broker for `day`: { finvasia: {acct: n}, angelone: {...} }. */
function notesOn(root, day) {
  const by = {};
  for (const l of readDay(root, day)) {
    if (l.status !== 'note') continue;
    by[l.broker] ??= {};
    by[l.broker][l.account] = new Decimal(l.fno.final_net);
  }
  return by;
}

const sum = (o) => Object.values(o ?? {}).reduce((s, v) => s.plus(v), new Decimal(0));
const near = (a, b) => a.minus(b).abs().lte(TOLERANCE);
const fmt = (d) => d.toFixed(2);

/**
 * Compare one broker's day. Returns null when the sheet and the notes agree; otherwise a reason
 * that helps the owner explain it.
 */
function judge(sheet, blank, notes) {
  const total = sum(notes);
  if (near(sheet, total)) return null;
  if (blank && !total.isZero()) return 'the sheet has no figure; the notes do';
  if (Object.keys(notes ?? {}).length === 0)
    return 'the sheet has a figure; no note for this broker';
  for (const [acct, v] of Object.entries(notes)) {
    if (Object.keys(notes).length > 1 && near(sheet, v)) {
      return `the sheet matches one account only (${acct.slice(0, 2)}··${acct.slice(-2)})`;
    }
  }
  const gap = sheet.minus(total);
  if (gap.mod(500).isZero()) return `a round difference of ${fmt(gap)} — edited by hand?`;
  return `differs by ${fmt(gap)}`;
}

function reconcile(root, rows) {
  const lines = [];
  const counts = {};
  const tally = (key) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  for (const row of rows) {
    const notes = notesOn(root, row.day);
    const period = row.day < '2025-04-28' ? 'typed by hand' : 'written by trade-analytics';
    for (const [broker, sheet, blank] of [
      ['finvasia', row.finvasia, row.blankFinvasia],
      ['angelone', row.angel, row.blankAngel],
    ]) {
      if (blank && sum(notes[broker]).isZero()) continue; // nothing on either side
      const reason = judge(sheet, blank, notes[broker]);
      tally(`${period} · ${broker} · ${reason ? 'differs' : 'matches'}`);
      if (reason) {
        lines.push({
          day: row.day,
          broker,
          sheet: fmt(sheet),
          notes: fmt(sum(notes[broker])),
          diff: fmt(sheet.minus(sum(notes[broker]))),
          reason,
        });
      }
    }
  }
  return { lines, counts };
}

function report(rows, { lines, counts }, csvPath) {
  const first = rows[0]?.day;
  const last = rows[rows.length - 1]?.day;
  const out = [
    `# Sheet against contract notes, ${first} → ${last}`,
    '',
    `Sheet: ${path.basename(csvPath)}. A day matches when the sheet's net (obligation − brokerage − other) is within ₹${TOLERANCE} of the notes' final net for that broker (every Finvasia account together). Each difference below needs an explanation before BL-168 Phase 3 is done: an extractor fix, a hand edit in the sheet, or a note the sheet missed.`,
    '',
    '| Period · broker · result | Days |',
    '|---|---|',
    ...Object.entries(counts)
      .sort()
      .map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '| Day | Broker | Sheet | Notes | Sheet − notes | Why it may differ |',
    '|---|---|---|---|---|---|',
    ...lines.map(
      (l) => `| ${l.day} | ${l.broker} | ${l.sheet} | ${l.notes} | ${l.diff} | ${l.reason} |`,
    ),
    '',
  ];
  return out.join('\n');
}

function importManual(root, rows, at) {
  let n = 0;
  const dir = path.join(root, 'manual');
  fs.mkdirSync(dir, { recursive: true });
  for (const row of rows) {
    const algos = row.algos && !row.algos.blank ? row.algos.value.toNumber() : null;
    const capital = row.capital && !row.capital.blank ? row.capital.value.toNumber() : null;
    if (algos == null && capital == null) continue;
    const file = path.join(dir, `${row.day}.json`);
    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // none yet
    }
    // A value typed on the page or read at 15:50 is newer than the sheet's: never written over.
    const next = {
      day: row.day,
      algos: current.algos ?? algos,
      capital_total: current.capital_total ?? capital,
      ...current,
      source: current.source ?? 'sheet',
      imported_at: current.imported_at ?? at,
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, file);
    n++;
  }
  return n;
}

function main(argv, env = process.env, now = new Date()) {
  const args = [...argv];
  const csvPath = args.find((a) => !a.startsWith('--'));
  if (!csvPath)
    throw new Error('usage: node reconcile.js <sheet.csv> [--import-manual] [--out DIR]');
  const outIdx = args.indexOf('--out');
  loadBrokerAccounts(env.BROKER_ACCOUNTS_JSON); // same config the run reads: fail early if missing
  const root = storeRoot(env);
  const rows = sheetRows(fs.readFileSync(csvPath, 'utf8'));
  const result = reconcile(root, rows);
  const outDir = outIdx >= 0 ? args[outIdx + 1] : path.join(root, 'reconcile');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = istNow(now).day;
  const file = path.join(outDir, `sheet-vs-notes-${stamp}.md`);
  fs.writeFileSync(file, report(rows, result, csvPath));
  console.log(`report: ${file}`);
  for (const [k, v] of Object.entries(result.counts).sort()) console.log(`  ${k}: ${v}`);
  if (args.includes('--import-manual')) {
    console.log(`manual inputs imported for ${importManual(root, rows, now.toISOString())} day(s)`);
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`reconcile: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { parseCsv, sheetDay, sheetRows, judge, reconcile, importManual, main };
