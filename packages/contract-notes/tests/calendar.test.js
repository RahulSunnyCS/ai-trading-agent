const { addDays, isTradingDay, istNow, lastSession, sessionsBack } = require('../calendar');

describe('isTradingDay()', () => {
  test('weekdays trade, weekends do not', () => {
    expect(isTradingDay('2026-10-23')).toBe(true); // Friday
    expect(isTradingDay('2026-10-24')).toBe(false); // Saturday
    expect(isTradingDay('2026-10-25')).toBe(false); // Sunday
  });

  test('reads the shared holidays.csv', () => {
    expect(isTradingDay('2024-01-26')).toBe(false); // Republic Day
  });
});

describe('istNow()', () => {
  test('is UTC + 05:30', () => {
    expect(istNow(new Date('2026-10-26T18:31:00Z'))).toEqual({ day: '2026-10-27', hhmm: '00:01' });
  });
});

describe('lastSession()', () => {
  test("after 16:00 IST on a trading day, today's note may be in", () => {
    expect(lastSession(new Date('2026-10-23T11:00:00Z'))).toBe('2026-10-23'); // Fri 16:30 IST
  });

  test('before 16:00 IST, the previous session', () => {
    expect(lastSession(new Date('2026-10-23T09:00:00Z'))).toBe('2026-10-22'); // Fri 14:30 IST
  });

  test('the 00:00 run on Saturday takes Friday', () => {
    expect(lastSession(new Date('2026-10-23T18:30:00Z'))).toBe('2026-10-23'); // Sat 00:00 IST
  });

  test('Monday morning takes Friday', () => {
    expect(lastSession(new Date('2026-10-26T02:00:00Z'))).toBe('2026-10-23'); // Mon 07:30 IST
  });
});

describe('sessionsBack()', () => {
  test('counts trading days only, oldest first', () => {
    expect(sessionsBack('2026-10-26', 3)).toEqual(['2026-10-22', '2026-10-23', '2026-10-26']);
  });

  test('addDays crosses months', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });
});
