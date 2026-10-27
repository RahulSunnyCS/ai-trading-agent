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

/** "1-Apr-25", "28 Apr 25", "3 Sept 2025", "2025-04-01" → 'YYYY-MM-DD'; null if not a date. */
function sheetDay(text) {
  const t = String(text || '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) return t;
  const p = t.split(/[\s-]+/);
  if (p.length !== 3) return null;
  const month = MONTHS.findIndex((m) => m.toLowerCase() === p[1].slice(0, 3).toLowerCase());
  const d = Number(p[0]);
  const y = p[2].length === 4 ? Number(p[2]) : 2000 + Number(p[2]);
  if (month < 0 || !d || !Number.isFinite(y)) return null;
  return `${y}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * A sheet cell as a Decimal. Blank, "N/A" and "-" read as zero and say so (`blank`); "₹",
 * thousands commas and a bracketed negative are understood; anything else is `bad`, reported.
 */
function cell(text) {
  const raw = String(text ?? '').trim();
  const t = raw.replace(/[₹,\s]/g, '');
  if (!t || t === 'N/A' || t === '-') return { value: new Decimal(0), blank: true };
  const neg = /^\((.*)\)$/.exec(t);
  try {
    const v = new Decimal(neg ? neg[1] : t);
    return { value: neg ? v.negated() : v, blank: false };
  } catch {
    return { value: new Decimal(0), blank: true, bad: raw };
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
    ['Brokerage(Angel One)', cols.angel[1]],
    ['Other Charges(Angel One)', cols.angel[2]],
    ['Sell Algo(Mummy)', cols.finvasia[0]],
    ['Brokerage(Mummy)', cols.finvasia[1]],
    ['Other charge', cols.finvasia[2]],
  ].filter(([, i]) => i < 0);
  if (missing.length) {
    throw new Error(
      `the CSV has no column ${missing.map(([n]) => `"${n}"`).join(', ')} — is it the Trade Book tab?`,
    );
  }
  return cols;
}

/**
 * The sheet's days as { day, angel, finvasia, blankAngel, blankFinvasia, algos, capital, rows,
 * bad }. Two rows with one date (the sheet has some) are one day: their nets and algos added.
 */
function sheetRows(csvText) {
  const [header, ...rest] = parseCsv(csvText);
  const cols = columns(header);
  const byDay = new Map();
  for (const r of rest) {
    const day = sheetDay(r[cols.date]);
    if (!day) continue;
    const net = (idx) => {
      const cells = idx.map((i) => cell(r[i]));
      const [obl, brk, oth] = cells;
      const bad = cells.filter((c) => c.bad).map((c) => c.bad);
      return {
        value: obl.value.minus(brk.value).minus(oth.value),
        blank: obl.blank && !obl.bad,
        bad,
      };
    };
    const a = net(cols.angel);
    const f = net(cols.finvasia);
    const algos = cols.algos >= 0 ? cell(r[cols.algos]) : { blank: true };
    const capital = cols.capital >= 0 ? cell(r[cols.capital]) : { blank: true };
    const prev = byDay.get(day);
    if (!prev) {
      byDay.set(day, {
        day,
        angel: a.value,
        finvasia: f.value,
        blankAngel: a.blank,
        blankFinvasia: f.blank,
        algos: algos.blank ? null : algos.value,
        capital: capital.blank ? null : capital.value,
        rows: 1,
        bad: { angelone: a.bad, finvasia: f.bad },
      });
      continue;
    }
    prev.angel = prev.angel.plus(a.value);
    prev.finvasia = prev.finvasia.plus(f.value);
    prev.blankAngel &&= a.blank;
    prev.blankFinvasia &&= f.blank;
    if (!algos.blank) prev.algos = (prev.algos ?? new Decimal(0)).plus(algos.value);
    if (!capital.blank) prev.capital ??= capital.value;
    prev.rows += 1;
    prev.bad.angelone.push(...a.bad);
    prev.bad.finvasia.push(...f.bad);
  }
  return [...byDay.values()].sort((x, y) => x.day.localeCompare(y.day));
}

/**
 * The stored lines of `day` for the configured accounts: { finvasia: { acct: final net },
 * angelone: {...}, failed: Set(broker) }.
 */
function notesOn(root, day, configured) {
  const by = { failed: new Set() };
  for (const l of readDay(root, day)) {
    if (!configured.has(`${l.broker}/${l.account}`)) continue;
    if (l.status === 'failed') by.failed.add(l.broker);
    if (l.status !== 'note' || !l.fno) continue;
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
function judge(sheet, blank, notes, failed = false) {
  const total = sum(notes);
  if (near(sheet, total) && !failed) return null;
  if (failed) return 'a note for this broker could not be read (see the nightly alerts)';
  if (blank && !total.isZero()) return 'the sheet has no figure; the notes do';
  if (Object.keys(notes ?? {}).length === 0) {
    return 'the sheet has a figure; no note for this broker';
  }
  for (const [acct, v] of Object.entries(notes)) {
    if (Object.keys(notes).length > 1 && near(sheet, v)) {
      return `the sheet matches one account only (${acct.slice(0, 2)}··${acct.slice(-2)})`;
    }
  }
  const gap = sheet.minus(total);
  if (gap.mod(500).isZero()) return `a round difference of ${fmt(gap)} — edited by hand?`;
  return `differs by ${fmt(gap)}`;
}

/** Every day with a stored line, from the store's file names. */
function storedDays(root) {
  try {
    return fs
      .readdirSync(path.join(root, 'days'))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, 10));
  } catch {
    return [];
  }
}

/**
 * Every day of the sheet's span — its rows, and every day the store has a note for that the
 * sheet has no row for — compared per broker.
 */
function reconcile(root, rows, configured) {
  const lines = [];
  const counts = {};
  const tally = (key) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const first = rows[0]?.day;
  const last = rows[rows.length - 1]?.day;
  const sheetByDay = new Map(rows.map((r) => [r.day, r]));
  const days = [
    ...new Set([
      ...rows.map((r) => r.day),
      ...storedDays(root).filter((d) => d >= first && d <= last),
    ]),
  ].sort();
  for (const day of days) {
    const row = sheetByDay.get(day);
    const notes = notesOn(root, day, configured);
    const period = day < '2025-04-28' ? 'typed by hand' : 'written by trade-analytics';
    for (const broker of ['finvasia', 'angelone']) {
      const failed = notes.failed.has(broker);
      if (!row) {
        if (sum(notes[broker]).isZero() && !failed) continue;
        tally(`${period} · ${broker} · differs`);
        lines.push({
          day,
          broker,
          sheet: '—',
          notes: fmt(sum(notes[broker])),
          diff: '—',
          reason: 'a note with no sheet row',
        });
        continue;
      }
      const sheet = broker === 'finvasia' ? row.finvasia : row.angel;
      const blank = broker === 'finvasia' ? row.blankFinvasia : row.blankAngel;
      if (blank && sum(notes[broker]).isZero() && !failed) continue; // nothing on either side
      let reason = judge(sheet, blank, notes[broker], failed);
      if (reason && row.rows > 1) reason += ` (the sheet has ${row.rows} rows for this day, added)`;
      const bad = row.bad[broker];
      if (bad.length)
        reason = `${reason ?? 'matches'}; unreadable sheet cell(s): ${bad.join(', ')}`;
      tally(
        `${period} · ${broker} · ${reason && !reason.startsWith('matches') ? 'differs' : 'matches'}`,
      );
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

/**
 * The sheet's Algos and Capital as manual/<day>.json. Only a field the file does not have yet is
 * filled: a value from the page or the 15:50 reading (even an explicit null) is never written
 * over. Returns how many files changed.
 */
function importManual(root, rows, at) {
  let n = 0;
  const dir = path.join(root, 'manual');
  fs.mkdirSync(dir, { recursive: true });
  for (const row of rows) {
    const fromSheet = {
      algos: row.algos == null ? undefined : row.algos.toNumber(),
      capital_total: row.capital == null ? undefined : row.capital.toNumber(),
    };
    if (fromSheet.algos === undefined && fromSheet.capital_total === undefined) continue;
    const file = path.join(dir, `${row.day}.json`);
    let current = null;
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // none yet
    }
    const next = current ? { ...current } : { day: row.day, source: 'sheet', imported_at: at };
    const filled = [];
    for (const [k, v] of Object.entries(fromSheet)) {
      if (v !== undefined && !Object.hasOwn(next, k)) {
        next[k] = v;
        filled.push(k);
      }
    }
    if (!filled.length) continue;
    if (current) next.from_sheet = [...new Set([...(current.from_sheet ?? []), ...filled])];
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, file);
    n++;
  }
  return n;
}

function parseArgs(argv) {
  const opts = { csv: null, out: null, importManual: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--import-manual') opts.importManual = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown argument ${a}`);
    else opts.csv = a;
  }
  if (!opts.csv || (opts.out !== null && !opts.out)) {
    throw new Error('usage: node reconcile.js <sheet.csv> [--import-manual] [--out DIR]');
  }
  return opts;
}

function main(argv, env = process.env, now = new Date()) {
  const opts = parseArgs(argv);
  const config = loadBrokerAccounts(env.BROKER_ACCOUNTS_JSON);
  const configured = new Set(
    config.flatMap((mb) => mb.accounts.map((a) => `${a.broker}/${a.accountId}`)),
  );
  const root = storeRoot(env);
  const rows = sheetRows(fs.readFileSync(opts.csv, 'utf8'));
  const result = reconcile(root, rows, configured);
  const outDir = opts.out ?? path.join(root, 'reconcile');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `sheet-vs-notes-${istNow(now).day}.md`);
  fs.writeFileSync(file, report(rows, result, opts.csv));
  console.log(`report: ${file}`);
  for (const [k, v] of Object.entries(result.counts).sort()) console.log(`  ${k}: ${v}`);
  if (opts.importManual) {
    console.log(`manual inputs filled for ${importManual(root, rows, now.toISOString())} day(s)`);
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

module.exports = { parseCsv, sheetDay, sheetRows, judge, reconcile, importManual, parseArgs, main };
