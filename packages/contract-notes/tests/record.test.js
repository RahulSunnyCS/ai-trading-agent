const { closeWithoutNotes, fnoBlock, key, noteLine, openPairs } = require('../record');

const ACC = { broker: 'finvasia', accountId: 'FA1' };
const AT = '2026-10-27T00:00:00.000Z';
const S = ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26'];

function statusOf(entries) {
  const m = new Map();
  for (const [day, status] of entries) {
    m.set(key(day, ACC.broker, ACC.accountId), {
      day,
      broker: ACC.broker,
      account: ACC.accountId,
      status,
    });
  }
  return m;
}

describe('fnoBlock()', () => {
  test('derives total charges and final net exactly', () => {
    // 0.1 + 0.2 is not 0.3 in floating point; Decimal keeps it exact.
    const b = fnoBlock({ payin_payout_obligation: 1, net_brokerage: 0.1, other_charges: 0.2 });
    expect(b.total_charges).toBe(0.3);
    expect(b.final_net).toBe(0.7);
  });
});

describe('noteLine()', () => {
  test("carries the sheet's five figures and the note's provenance", () => {
    const line = noteLine({
      day: '2026-10-23',
      broker: 'finvasia',
      account: 'FA1',
      extracted: {
        payin_payout_obligation: 2231,
        net_brokerage: 100,
        other_charges: 80.6,
        skipped_segments: [],
      },
      note: { sha256: 'abc', file: 'raw/x.pdf', subject: 's', received: 'r', attachment: 'a.pdf' },
      at: AT,
    });
    expect(line.status).toBe('note');
    expect(line.fno).toEqual({
      payin_payout_obligation: 2231,
      net_brokerage: 100,
      other_charges: 80.6,
      total_charges: 180.6,
      final_net: 2050.4,
    });
    expect(line.note.sha256).toBe('abc');
  });
});

describe('openPairs()', () => {
  test('a session is open until a line closes it', () => {
    const open = openPairs(
      S,
      [ACC],
      statusOf([
        ['2026-10-21', 'note'],
        ['2026-10-22', 'no_trade'],
      ]),
    );
    expect(open.map((p) => p.day)).toEqual(['2026-10-23', '2026-10-26']);
  });
});

describe('closeWithoutNotes()', () => {
  test('a session before the newest note, with none of its own, had no trade', () => {
    const { lines, quiet } = closeWithoutNotes(S, [ACC], statusOf([['2026-10-23', 'note']]), AT);
    expect(lines.map((l) => [l.day, l.status])).toEqual([
      ['2026-10-21', 'no_trade'],
      ['2026-10-22', 'no_trade'],
    ]);
    expect(quiet).toEqual([]);
  });

  test('sessions after the newest note stay open: their notes may still come', () => {
    const { lines } = closeWithoutNotes(S, [ACC], statusOf([['2026-10-23', 'note']]), AT);
    expect(lines.some((l) => l.day === '2026-10-26')).toBe(false);
  });

  test('a failed note keeps its session open, never no_trade', () => {
    const { lines, quiet } = closeWithoutNotes(
      S,
      [ACC],
      statusOf([
        ['2026-10-21', 'failed'],
        ['2026-10-23', 'note'],
      ]),
      AT,
    );
    expect(lines.map((l) => [l.day, l.status])).toEqual([['2026-10-22', 'no_trade']]);
    expect(quiet).toEqual([]);
  });

  test('no note in the whole window closes the oldest session and lists the account as quiet', () => {
    const { lines, quiet } = closeWithoutNotes(S, [ACC], statusOf([]), AT);
    expect(lines.map((l) => [l.day, l.status])).toEqual([['2026-10-21', 'no_note']]);
    expect(quiet).toEqual([ACC]);
  });

  test('an account with only a failed note is not quiet', () => {
    const { lines, quiet } = closeWithoutNotes(S, [ACC], statusOf([['2026-10-22', 'failed']]), AT);
    expect(lines).toEqual([]);
    expect(quiet).toEqual([]);
  });

  test('closed sessions are left alone', () => {
    const { lines } = closeWithoutNotes(
      S,
      [ACC],
      statusOf([
        ['2026-10-21', 'note'],
        ['2026-10-22', 'no_trade'],
        ['2026-10-23', 'note'],
        ['2026-10-26', 'note'],
      ]),
      AT,
    );
    expect(lines).toEqual([]);
  });
});

describe('noteLine() for an equity note', () => {
  test('keeps eq and trades, and has no fno block', () => {
    const line = noteLine({
      day: '2026-10-23',
      broker: 'kite',
      account: 'BZ1',
      extracted: {
        eq: { payin_payout_obligation: -100, charges: {}, total_charges: 1, final_net: -101 },
        trades: [{ symbol: 'ALPHA', side: 'buy', qty: 1, price: 100, value: 100 }],
      },
      note: { sha256: 'x' },
      at: AT,
    });
    expect(line.fno).toBeUndefined();
    expect(line.eq.final_net).toBe(-101);
    expect(line.trades).toHaveLength(1);
  });
});
