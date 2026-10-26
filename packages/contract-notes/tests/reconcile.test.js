const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Decimal = require('decimal.js');
const {
  importManual,
  judge,
  parseArgs,
  parseCsv,
  reconcile,
  sheetDay,
  sheetRows,
} = require('../reconcile');
const { writeLine } = require('../store');

const HEADER =
  'No,Day,Date,Sell Algo(Angel One),Brokerage(Angel One),Other Charges(Angel One),Total Charges(Angel One),Final Net(Angel One),Sell Algo(Mummy),Brokerage(Mummy),Other charge,Final Net(Finvasia),Total Charge(finvasia),Algos,algo charges,Charges,Profit,Overall,DD,50 Avg Profit,100 Avg Profit,100 Avg Charge,Charge/Profit Ratio,Capital';

let root;
const CONFIGURED = new Set(['finvasia/FA24', 'finvasia/FA73', 'angelone/R20']);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-rec-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const note = (day, broker, account, finalNet) =>
  writeLine(root, { day, broker, account, status: 'note', fno: { final_net: finalNet } });

describe('parseCsv() / sheetDay()', () => {
  test('quoted fields keep their commas and quotes', () => {
    expect(parseCsv('a,"b,c","d ""e"""\n1,2,3\n')).toEqual([
      ['a', 'b,c', 'd "e"'],
      ['1', '2', '3'],
    ]);
  });

  test('both date styles the sheet uses, and Sept', () => {
    expect(sheetDay('1-Apr-25')).toBe('2025-04-01');
    expect(sheetDay('28 Apr 25')).toBe('2025-04-28');
    expect(sheetDay('3 Sept 25')).toBe('2025-09-03');
    expect(sheetDay('FY27')).toBeNull();
    expect(sheetDay('3 Sep 2025')).toBe('2025-09-03');
    expect(sheetDay('2025-09-03')).toBe('2025-09-03');
  });
});

describe('judge()', () => {
  const D = (n) => new Decimal(n);
  test('agrees within a rupee', () => {
    expect(judge(D(100.4), false, { A: D(100) })).toBeNull();
  });
  test('names the usual reasons', () => {
    expect(judge(D(0), true, { A: D(50) })).toMatch(/no figure; the notes do/);
    expect(judge(D(50), false, {})).toMatch(/no note/);
    expect(judge(D(70), false, { A: D(70), B: D(30) })).toMatch(/one account only/);
    expect(judge(D(2100), false, { A: D(100) })).toMatch(/round difference of 2000\.00/);
    expect(judge(D(133), false, { A: D(100) })).toMatch(/differs by 33\.00/);
  });
});

describe('reconcile()', () => {
  test('adds every Finvasia account and compares each broker apart', () => {
    note('2025-05-02', 'finvasia', 'FA24', 2800.91);
    note('2025-05-02', 'finvasia', 'FA73', 931.64);
    note('2025-05-02', 'angelone', 'R20', 500);
    const csv = [
      HEADER,
      // Finvasia: 4586.25 − 853.70 − 0 = 3732.55 = 2800.91 + 931.64; Angel One: blank, note 500
      '1,Friday,2 May 25,,,,,,4586.25,853.70,,,,8,125,979,3607,0,0,,,,,1200000',
    ].join('\n');
    const { lines, counts } = reconcile(root, sheetRows(csv), CONFIGURED);
    expect(counts['written by trade-analytics · finvasia · matches']).toBe(1);
    expect(lines).toEqual([
      expect.objectContaining({
        broker: 'angelone',
        reason: 'the sheet has no figure; the notes do',
      }),
    ]);
  });
});

describe('importManual()', () => {
  test("stores the sheet's Algos and Capital, never over a newer value", () => {
    const rows = sheetRows(
      [HEADER, '1,Friday,2 May 25,,,,,,100,10,,,,8,125,979,3607,0,0,,,,,1200000'].join('\n'),
    );
    fs.mkdirSync(path.join(root, 'manual'));
    fs.writeFileSync(
      path.join(root, 'manual', '2025-05-02.json'),
      JSON.stringify({ day: '2025-05-02', algos: 9, source: 'page' }),
    );
    expect(importManual(root, rows, 't')).toBe(1);
    const stored = JSON.parse(
      fs.readFileSync(path.join(root, 'manual', '2025-05-02.json'), 'utf8'),
    );
    expect(stored).toMatchObject({
      algos: 9,
      capital_total: 1200000,
      source: 'page',
      from_sheet: ['capital_total'],
    });
    expect(importManual(root, rows, 't')).toBe(0); // nothing new: the file is left alone
  });
});

describe('reconcile() — the review of #336', () => {
  test('two sheet rows for one day are added before comparing', () => {
    note('2025-05-20', 'finvasia', 'FA24', 300);
    const csv = [
      HEADER,
      '1,Tuesday,20 May 25,,,,,,250,10,,,,8,125,0,0,0,0,,,,,1200000',
      '2,Tuesday,20 May 25,,,,,,70,10,,,,2,0,0,0,0,0,,,,,1200000',
    ].join('\n');
    const rows = sheetRows(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].algos.toNumber()).toBe(10);
    expect(reconcile(root, rows, CONFIGURED).lines).toEqual([]);
  });

  test('a stored note on a day the sheet has no row for is reported', () => {
    note('2025-05-02', 'finvasia', 'FA24', 100);
    note('2025-05-05', 'finvasia', 'FA24', 200); // no sheet row
    note('2025-05-06', 'finvasia', 'FA24', 300);
    const csv = [
      HEADER,
      '1,Friday,2 May 25,,,,,,100,0,,,,0,0,0,0,0,0,,,,,0',
      '2,Tuesday,6 May 25,,,,,,300,0,,,,0,0,0,0,0,0,,,,,0',
    ].join('\n');
    const { lines } = reconcile(root, sheetRows(csv), CONFIGURED);
    expect(lines).toEqual([
      expect.objectContaining({ day: '2025-05-05', reason: 'a note with no sheet row' }),
    ]);
  });

  test('an account not in the config, a failed note and an unreadable cell are said so', () => {
    note('2025-05-02', 'finvasia', 'OTHER', 999); // not configured: ignored
    writeLine(root, { day: '2025-05-02', broker: 'angelone', account: 'R20', status: 'failed' });
    const csv = [HEADER, '1,Friday,2 May 25,50,0,,,,abc,0,,,,0,0,0,0,0,0,,,,,0'].join('\n');
    const { lines } = reconcile(root, sheetRows(csv), CONFIGURED);
    expect(lines.map((l) => [l.broker, l.reason])).toEqual([
      ['finvasia', expect.stringMatching(/unreadable sheet cell\(s\): abc/)],
      ['angelone', expect.stringMatching(/could not be read/)],
    ]);
  });

  test('a bracketed negative and a rupee sign are read; a column missing is refused', () => {
    note('2025-05-02', 'angelone', 'R20', -1500);
    const csv = [HEADER, '1,Friday,2 May 25,"(₹1,500.00)",0,,,,,,,,,0,0,0,0,0,0,,,,,0'].join('\n');
    expect(reconcile(root, sheetRows(csv), CONFIGURED).lines).toEqual([]);
    expect(() => sheetRows(HEADER.replace('Other charge,', 'Notes,'))).toThrow(/"Other charge"/);
  });

  test('--out takes its value, not the CSV', () => {
    expect(parseArgs(['--out', '/tmp/x', 'sheet.csv'])).toEqual({
      csv: 'sheet.csv',
      out: '/tmp/x',
      importManual: false,
    });
  });
});
