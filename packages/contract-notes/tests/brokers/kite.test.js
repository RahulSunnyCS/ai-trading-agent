const { extract, noteDay, searchSubject } = require('../../brokers/kite');

// The shape pdf-parse gives a Zerodha equity note: the totals block (brackets = payable, a
// footnote digit after "(₹)" on some rows) and Annexure A's run-together trade rows. Symbols,
// ISINs, order numbers and amounts are made up.
function note({ totals, trades }) {
  return `Contract Note No:CNT-XX NCL-CashNCL-F&O
...
NCL-CashNCL-F&ONET TOTAL
${totals}

1In the case of cross currency trades, the traded currency is converted to INR.

Annexure A
Equity
Order No.Order TimeTrade No.Trade TimeSecurity / Contract DescriptionBuy(B) /
Sell(S)
${trades}
`;
}

const BUY_DAY = note({
  totals: `Pay in/Pay out obligation (₹)(4500.00)0.00(4500.00)
Taxable value of Supply (Brokerage) (₹)2(0.01)(0.01)
Exchange transaction charges (₹)4(0.15)(0.15)
Clearing charges (₹)
CGST (@9% of Brok, SEBI, Trans & Clearing Charges) (₹)3
SGST (@9% of Brok, SEBI, Trans & Clearing Charges) (₹)3
IGST (@18% of Brok, SEBI, Trans & Clearing Charges) (₹)3(0.03)(0.03)
Securities transaction tax (₹)(5.00)(5.00)
SEBI turnover fees (₹)(0.01)(0.01)
Stamp duty (₹)(1.00)(1.00)
Net amount receivable/(payable by client) (₹)
(4506.20)0.00(4506.20)`,
  trades: `100000000111111109:37:2611111109:37:26ALPHA-EQ/INE000A01011BNSE120.0000250.00(3000.00)
120000000222222209:37:4222222222209:37:42BETA-EQ/INE000B01012BNSE100.0000150.00(1500.00)`,
});

// A receipt prints unbracketed, and a BSE row has a longer order number, a group suffix and a
// symbol that starts with digits.
const SELL_DAY = note({
  totals: `Pay in/Pay out obligation (₹)5961.200.005961.20
Taxable value of Supply (Brokerage) (₹)2(0.01)(0.01)
Exchange transaction charges (₹)4(0.40)(0.40)
Clearing charges (₹)
IGST (@18% of Brok, SEBI, Trans & Clearing Charges) (₹)3(0.07)(0.07)
Securities transaction tax (₹)(12.00)(12.00)
SEBI turnover fees (₹)(0.01)(0.01)
Stamp duty (₹)(0.08)(0.08)
Net amount receivable/(payable by client) (₹)
5948.630.005948.63`,
  trades: `110000000000000003310:19:03383800010:19:0320GAMMA-B/INE000C01013SBSE500.0000182.509125.00
110000000000000004410:20:05175070010:20:05DELTA-A/INE000D01014BBSE40.0000790.95(3163.80)`,
});

describe('kite.searchSubject() / noteDay()', () => {
  test('searches every equity note of the account', () => {
    expect(searchSubject('BZ1234')).toBe('Combined Equity Contract Note for BZ1234');
  });

  test('reads the session from the attachment name', () => {
    expect(noteDay({ filename: '22-10-2026-contract-notes_BZ1234.pdf', accountId: 'BZ1234' })).toBe(
      '2026-10-22',
    );
    expect(
      noteDay({ filename: '22-10-2026-contract-notes_XY9.pdf', accountId: 'BZ1234' }),
    ).toBeNull();
  });
});

describe('kite.extract()', () => {
  test('a buying day: payable in brackets, charges itemised, trades read', () => {
    const r = extract(BUY_DAY);
    expect(r.error).toBeUndefined();
    expect(r.eq).toEqual({
      payin_payout_obligation: -4500,
      charges: {
        brokerage: 0.01,
        exchange: 0.15,
        clearing: 0,
        cgst: 0,
        sgst: 0,
        igst: 0.03,
        stt: 5,
        sebi: 0.01,
        stamp: 1,
      },
      total_charges: 6.2,
      final_net: -4506.2,
    });
    expect(r.trades.map((t) => [t.symbol, t.side, t.qty, t.price, t.value])).toEqual([
      ['ALPHA', 'buy', 12, 250, 3000],
      ['BETA', 'buy', 10, 150, 1500],
    ]);
  });

  test('a selling day: an unbracketed receipt is not read as a footnote', () => {
    const r = extract(SELL_DAY);
    expect(r.error).toBeUndefined();
    expect(r.eq.payin_payout_obligation).toBe(5961.2);
    expect(r.eq.final_net).toBe(5948.63);
    expect(r.trades.map((t) => [t.symbol, t.side, t.exchange, t.qty])).toEqual([
      ['20GAMMA', 'sell', 'BSE', 50],
      ['DELTA', 'buy', 'BSE', 4],
    ]);
  });

  test('an F&O figure on the Momentum account is refused', () => {
    const fno = BUY_DAY.replace('(4500.00)0.00(4500.00)', '(4500.00)(100.00)(4600.00)');
    expect(extract(fno).error).toMatch(/F&O figure/);
  });

  test('trades that do not add up to the obligation are refused', () => {
    const wrong = BUY_DAY.replace('(4500.00)0.00(4500.00)', '(4400.00)0.00(4400.00)').replace(
      '(4506.20)0.00(4506.20)',
      '(4406.20)0.00(4406.20)',
    );
    expect(extract(wrong).error).toMatch(/trades sum to/);
  });
});
