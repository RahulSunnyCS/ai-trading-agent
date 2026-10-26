const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { READERS, dmy, readLedger, readLedgerDay, writeEvent } = require('../ledger');

// Every amount, date and account here is invented; the sentences follow the brokers' wording.
const reader = (kind) => READERS.find((r) => r.kind === kind);
const mail = (text, from = 'alerts@angelone.in', received = '2026-10-17T09:14:00Z') => ({
  uid: 1,
  subject: 's',
  received,
  messageId: `<${text.length}@x>`,
  from,
  text,
});

describe('the readers', () => {
  test('a deposit', () => {
    const { events } = readLedger(
      reader('deposit'),
      [mail('You have successfully added ₹30000.00 to your Angel One account via UPI.')],
      'R1',
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: 'deposit', amount: 30000, day: '2026-10-17', account: 'R1' }),
    ]);
  });

  test('collateral interest, booked on the session it is for', () => {
    const { events } = readLedger(
      reader('collateral_interest'),
      [
        mail(
          'An interest of ₹ 12.34 will be charged for the collateral margin used on 2026-10-15. The cash collateral shortfall was ₹ 100000.00.',
        ),
      ],
      'R1',
    );
    expect(events[0]).toMatchObject({ amount: 12.34, day: '2026-10-15', shortfall: 100000 });
  });

  test('margin warnings in both wordings', () => {
    const r = reader('margin_warning');
    const oct = readLedger(
      r,
      [
        mail(
          'Your account has reached 90.50% of your available margin as on 22-Oct-2026, 10:05:58 AM. Margin Available ₹ 1000.00 Margin Utilised* ₹ 905.00',
        ),
      ],
      'R1',
    ).events[0];
    expect(oct).toMatchObject({
      utilisation_pct: 90.5,
      day: '2026-10-22',
      time: '10:05:58 AM',
      margin_available: 1000,
      margin_used: 905,
    });
    const sep = readLedger(
      r,
      [mail('Your account has reached 95% of your available margin as on 2026-09-09 12:45:58.')],
      'R1',
    ).events[0];
    expect(sep).toMatchObject({ utilisation_pct: 95, day: '2026-09-09', time: '12:45:58' });
  });

  test('a Zerodha payout, on the day it says', () => {
    const { events } = readLedger(
      reader('withdrawal'),
      [
        mail(
          'Your instant payout request for ₹5000.00 was processed and has been deposited to your bank account ending with 0000 on 15 Sep 2026.',
          'noreply@mailer.zerodha.com',
        ),
      ],
      'BZ1',
    );
    expect(events[0]).toMatchObject({ kind: 'withdrawal', amount: 5000, day: '2026-09-15' });
  });

  test('a settlement e-mail with no amount is still an event', () => {
    const { events } = readLedger(
      reader('settlement'),
      [mail('Your funds have been settled.', 'x@shoonya.com')],
      'FA1',
    );
    expect(events[0]).toMatchObject({ kind: 'settlement', amount: null });
  });

  test('another sender is ignored; the right sender in other words is unread', () => {
    const r = reader('deposit');
    const { events, unread } = readLedger(
      r,
      [mail('added ₹1.00', 'spam@else.com'), mail('Your money arrived.')],
      'R1',
    );
    expect(events).toEqual([]);
    expect(unread).toHaveLength(1);
  });

  test('dmy reads both date styles', () => {
    expect(dmy('22-Oct-2026')).toBe('2026-10-22');
    expect(dmy('15 Sep 2026')).toBe('2026-09-15');
  });
});

describe('the store', () => {
  test('one event per message, written atomically', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-ledger-'));
    const e = { day: '2026-10-17', kind: 'deposit', message_id: '<a>', amount: 1 };
    expect(writeEvent(root, e)).toBe(true);
    expect(writeEvent(root, e)).toBe(false);
    expect(readLedgerDay(root, '2026-10-17')).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
