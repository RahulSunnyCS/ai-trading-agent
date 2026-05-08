import { describe, it, expect } from 'bun:test';
import { isMarketHours } from '../market-hours';

// isMarketHours accepts an optional `now` Date so we can control time in tests
// without mocking globals. IST = UTC+5:30.

function utc(hours: number, minutes: number): Date {
  const d = new Date(0);
  d.setUTCHours(hours, minutes, 0, 0);
  return d;
}

describe('isMarketHours', () => {
  it('returns true at market open (09:15 IST = 03:45 UTC)', () => {
    expect(isMarketHours(utc(3, 45))).toBe(true);
  });

  it('returns true at market close (15:30 IST = 10:00 UTC)', () => {
    expect(isMarketHours(utc(10, 0))).toBe(true);
  });

  it('returns false one minute before open (09:14 IST = 03:44 UTC)', () => {
    expect(isMarketHours(utc(3, 44))).toBe(false);
  });

  it('returns false one minute after close (15:31 IST = 10:01 UTC)', () => {
    expect(isMarketHours(utc(10, 1))).toBe(false);
  });

  it('returns true at midday (12:00 IST = 06:30 UTC)', () => {
    expect(isMarketHours(utc(6, 30))).toBe(true);
  });

  it('returns false at midnight IST (18:30 UTC previous day)', () => {
    expect(isMarketHours(utc(18, 30))).toBe(false);
  });

  it('returns false at midnight UTC (05:30 IST — before market open)', () => {
    expect(isMarketHours(utc(0, 0))).toBe(false);
  });
});
