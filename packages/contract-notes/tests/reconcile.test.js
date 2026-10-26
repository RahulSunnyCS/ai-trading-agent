const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Decimal = require('decimal.js');
const { importManual, judge, parseCsv, reconcile, sheetDay, sheetRows } = require('../reconcile');
const { writeLine } = require('../store');

const HEADER =
  'No,Day,Date,Sell Algo(Angel One),Brokerage(Angel One),Other Charges(Angel One),Total Charges(Angel One),Final Net(Angel One),Sell Algo(Mummy),Brokerage(Mummy),Other charge,Final Net(Finvasia),Total Charge(finvasia),Algos,algo charges,Charges,Profit,Overall,DD,50 Avg Profit,100 Avg Profit,100 Avg Charge,Charge/Profit Ratio,Capital';

let root;
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
    const { lines, counts } = reconcile(root, sheetRows(csv));
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
    expect(stored).toMatchObject({ algos: 9, capital_total: 1200000, source: 'page' });
  });
});
