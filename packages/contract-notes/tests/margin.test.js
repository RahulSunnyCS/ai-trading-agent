const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  STATEMENTS,
  fileInfo,
  fromOk,
  parseAngelone,
  parseFinvasia,
  readMarginDay,
  writeStatement,
} = require('../margin');

// Every figure, name and account here is invented; the layouts follow what pdf-parse prints for
// the brokers' statements (cells run together, numbers wrapped over two lines).

const ANGEL = `Angel One Limited
Client Code : R1
DAILY MARGIN STATEMENT FOR THE DAY : 02/11/2026
Margin Available Till T Day
Total
upfront/
Margin
ABCDE
F=(A+B+C+
D+E)
GHIJ=(G+H+I)K=(F-J)LM=(K-L)
NCE-F&O-100.000.000.000.000.00-100.000.000.000.000.00-100.000.00-100.00
EQUITY
50000.
00
0.000.000.000.0050000.000.000.000.000.0050000.000.0050000.00
NSE-F&O
-
20000.0
0
0.00300000.000.000.00280000.00250000.001000.000.00251000.0029000.000.0029000.00
Total
29900.
00
0.00300000.000.000.00329900.00250000.001000.000.00251000.0078900.000.0078900.00
Collateral Details :-
Securities :
Sr NoScrip NameSeries)QuantityClosing RateTotal ValueHair-cut %Value(After HairCut)Margin Account
1INE000A01011-ACME STEEL LTDEQ1000200.00200000.0020.00160000.00PLEDGE
2INE000B01012-WIDGET CORP LIMITEDEQ500350.00175000.0020.00140000.00PLEDGE
Total375000.00300000.00
Grand Total375000.00300000.00
`;

const FINVASIA = `FINVASIA SECURITIES PRIVATE LIMITED
Daily Margin Report of Trade Date 30-10 -2026
FA 1 - SOMEONE
Total
Requirement
Total
Margin
Available
GHJ=(G+H+I)K=(F-J)LM=(K-L)
Collaterals30-10-26 0.00 0.00 0.00 0.00 0.00 400000.00 0.00 0.00
NSEFNO30-10-26 0.00 0.00 0.00 0.00 2000.00 0.00 2,000.00 0.00
 50,000.00 448000.00 0.00 0.00 0.00 450000.00 0.00 2000.00 448000.00 0.00
Total
*Approved form as specified by the exchange/cc from time to time.
 400000.00 2,000.00 0.00
Details of Funds (A)
Clear FundsEarly Payin Credit
 50000.00
Net Funds
 0.00 50000.00
Holding Detail
HoldingValueHairCutClosePriceQuantityScripNameISIN
Margin Pledge Holding
Page 1 of 2
FA1
Account ID :
INE000A01011ACME STEEL LIMITED 1000 200.00 20.00 160000.00
INF000L01011SOME ETF LIQUID BEES 100 1000.00 10.00 90000.00
IN0020230093SOVEREIGN GOLD BONDS 2023-24 S 10 15000.00 0.00 150000.00
 400000.00
Total Holding Value
****End of Report ****
`;

describe("Angel One's statement", () => {
  test('reads every segment, the total and the collateral', () => {
    const s = parseAngelone(ANGEL);
    expect(s.error).toBeUndefined();
    expect(s.day).toBe('2026-11-02');
    expect(s.account).toBe('R1');
    expect(Object.keys(s.segments)).toEqual(['NCE-F&O', 'EQUITY', 'NSE-F&O']);
    expect(s.segments['NSE-F&O']).toMatchObject({
      funds: -20000,
      pledged: 300000,
      available: 280000,
      upfront: 250000,
      crystallised: 1000,
      requirement: 251000,
      excess: 29000,
    });
    expect(s.total).toMatchObject({ funds: 29900, available: 329900, upfront: 250000 });
    expect(s.holdings).toEqual([
      expect.objectContaining({
        isin: 'INE000A01011',
        name: 'ACME STEEL LTD',
        series: 'EQ',
        quantity: 1000,
        close: 200,
        haircut_pct: 20,
        value: 160000,
        account: 'PLEDGE',
      }),
      expect.objectContaining({ isin: 'INE000B01012', quantity: 500, close: 350 }),
    ]);
  });

  test('a figure that breaks the table’s own sums is refused, not stored', () => {
    const s = parseAngelone(ANGEL.replace('280000.00250000.00', '280001.00250000.00'));
    expect(s.error).toMatch(/NSE-F&O: available is not/);
  });

  test('segments that do not add up to the Total are refused', () => {
    const changed = ANGEL.replace(
      'EQUITY\n50000.\n00\n0.000.000.000.0050000.000.000.000.000.0050000.000.0050000.00',
      'EQUITY\n60000.\n00\n0.000.000.000.0060000.000.000.000.000.0060000.000.0060000.00',
    );
    expect(parseAngelone(changed).error).toMatch(/do not add up/);
  });

  test('collateral that does not add up to the pledged securities is refused', () => {
    expect(
      parseAngelone(ANGEL.replace('20.00140000.00PLEDGE', '20.00140001.00PLEDGE')).error,
    ).toMatch(/collateral/);
  });

  test('securities in the table with no readable collateral section are refused', () => {
    const noSection = ANGEL.slice(0, ANGEL.indexOf('Collateral Details'));
    expect(parseAngelone(noSection).error).toMatch(/no scrip could be read/);
  });

  test('a row with a wrong number of figures, or no table, is refused', () => {
    expect(parseAngelone(ANGEL.replace('-100.000.00-100.00\n', '-100.00\n')).error).toMatch(
      /figures, not 13/,
    );
    expect(parseAngelone('DAILY MARGIN STATEMENT FOR THE DAY : 02/11/2026').error).toMatch(
      /no margin table/,
    );
    expect(parseAngelone('something else').error).toMatch(/date/);
  });
});

describe("Finvasia's statement", () => {
  test('reads the Total row (not the header’s "Total"), the funds and the holdings', () => {
    const s = parseFinvasia(FINVASIA);
    expect(s.error).toBeUndefined();
    expect(s.day).toBe('2026-10-30');
    expect(s.account).toBe('FA1');
    expect(s.segments).toBeNull();
    expect(s.total).toEqual({
      funds: 50000,
      securities: 0,
      pledged: 400000,
      bank_guarantee: 0,
      other: 0,
      available: 450000,
      upfront: 0,
      crystallised: 2000,
      delivery: 0,
      requirement: 2000,
      excess: 448000,
      rms_additional: 0,
      status: 448000,
    });
    expect(s.holdings.map((h) => [h.isin, h.quantity, h.value])).toEqual([
      ['INE000A01011', 1000, 160000],
      ['INF000L01011', 100, 90000],
      ['IN0020230093', 10, 150000],
    ]);
  });

  test('holdings that do not add up are refused', () => {
    expect(parseFinvasia(FINVASIA.replace(' 10.00 90000.00', ' 10.00 90001.00')).error).toMatch(
      /holdings/,
    );
  });

  test('funds that differ from "Net Funds" are refused', () => {
    expect(
      parseFinvasia(FINVASIA.replace(' 0.00 50000.00\nHolding', ' 0.00 50001.00\nHolding')).error,
    ).toMatch(/Net Funds/);
  });

  test('a moved column breaks the sums and is refused', () => {
    const moved = FINVASIA.replace(
      ' 50,000.00 448000.00 0.00 0.00 0.00 450000.00 0.00 2000.00 448000.00 0.00',
      ' 50,000.00 448000.00 0.00 0.00 0.00 2000.00 0.00 450000.00 448000.00 0.00',
    );
    expect(parseFinvasia(moved).error).toMatch(/Total row/);
  });
});

describe('the statements’ mail', () => {
  const angel = STATEMENTS.find((s) => s.broker === 'angelone');
  const finvasia = STATEMENTS.find((s) => s.broker === 'finvasia');

  test('the file name gives the account and the trade date', () => {
    expect(fileInfo(angel, 'CM_R1_02112026.pdf')).toEqual({ account: 'R1', day: '2026-11-02' });
    expect(fileInfo(finvasia, 'MARGIN_FA1_30102026.pdf')).toEqual({
      account: 'FA1',
      day: '2026-10-30',
    });
    expect(fileInfo(angel, 'contract_note.pdf')).toBeNull();
  });

  test('only the broker’s own sender', () => {
    expect(fromOk(angel, 'contract.notes@angeltrade.in')).toBe(true);
    expect(fromOk(finvasia, 'Backoffice@shoonya.com')).toBe(true);
    expect(fromOk(angel, 'someone@example.com')).toBe(false);
  });
});

describe('the store', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-margin-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("one line per account and day: a revision replaces the account's line only", () => {
    writeStatement(root, { day: '2026-11-02', broker: 'finvasia', account: 'FA1', sha256: 'a' });
    writeStatement(root, { day: '2026-11-02', broker: 'angelone', account: 'R1', sha256: 'b' });
    writeStatement(root, { day: '2026-11-02', broker: 'finvasia', account: 'FA1', sha256: 'c' });
    expect(readMarginDay(root, '2026-11-02').map((l) => [l.account, l.sha256])).toEqual([
      ['R1', 'b'],
      ['FA1', 'c'],
    ]);
    expect(readMarginDay(root, '2026-11-03')).toEqual([]);
  });
});
