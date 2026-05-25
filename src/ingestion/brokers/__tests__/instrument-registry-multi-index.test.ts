/**
 * instrument-registry-multi-index.test.ts — T-45 additions
 *
 * Tests for the multi-index features added in T-45:
 *   1. BSE vs NSE prefix in buildOptionSymbol
 *   2. Calendar-driven expiry (getCurrentExpiryFromCalendar)
 *   3. Calendar freshness assert (assertCalendarFreshness)
 *      - Hard-fail on expired/empty calendar
 *      - Independent refill-reminder (advisory log)
 *   4. validateSimSymbol structural fixture
 *
 * No real DB connections. The PostgreSQL pool is mocked via a minimal query stub.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { FixedClock } from '../../../utils/clock.js';
import {
  buildOptionSymbol,
  EXCHANGE_PREFIXES,
  getCurrentExpiryFromCalendar,
  assertCalendarFreshness,
  CalendarExpiredError,
  validateSimSymbol,
  formatFyersExpiry,
} from '../instrument-registry.js';
import type { Underlying } from '../types.js';

// ---------------------------------------------------------------------------
// Shared test date: 2026-05-25 10:00 IST (Monday)
// IST = UTC+5:30, so UTC = 2026-05-25T04:30:00Z
// ---------------------------------------------------------------------------
const MON_IST_MS = new Date('2026-05-25T04:30:00.000Z').getTime();
const MON_CLOCK = new FixedClock(MON_IST_MS);
// clock.today() returns '2026-05-25'

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal Pool mock for getCurrentExpiryFromCalendar and
 * assertCalendarFreshness. Accepts optional overrides to simulate different
 * calendar states (no future expiry, max expiry date).
 */
function makeDbMock(opts: {
  futureExpiry?: string | null;   // null = no rows returned (calendar expired)
  maxExpiry?: string | null;      // max seeded expiry date for refill check
}): Pool {
  const { futureExpiry = '2026-05-28', maxExpiry = '2026-07-23' } = opts;

  const mockQuery = vi.fn().mockImplementation((sql: string, _params: unknown[]) => {
    // getCurrentExpiryFromCalendar: SELECT expiry_date LIMIT 1
    if (sql.includes('LIMIT 1') && sql.includes('expiry_date >= $2')) {
      if (futureExpiry === null) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({
        rows: [{ expiry_date: futureExpiry, is_holiday_shifted: false }],
      });
    }
    // assertCalendarFreshness — first query (future expiry check)
    if (sql.includes('ORDER BY expiry_date ASC') && sql.includes('LIMIT 1')) {
      if (futureExpiry === null) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({
        rows: [{ expiry_date: futureExpiry }],
      });
    }
    // assertCalendarFreshness — second query (MAX expiry for refill check)
    if (sql.includes('MAX(expiry_date)')) {
      return Promise.resolve({
        rows: [{ max_expiry: maxExpiry }],
      });
    }
    return Promise.resolve({ rows: [] });
  });

  return { query: mockQuery } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// 1. Exchange prefix — buildOptionSymbol
// ---------------------------------------------------------------------------

describe('buildOptionSymbol — exchange prefix', () => {
  // Use a fixed expiry date: 2026-05-28 (Thursday)
  const expiry = new Date('2026-05-28T00:00:00.000Z');

  it('NIFTY uses NSE: prefix', () => {
    const sym = buildOptionSymbol('NIFTY', expiry, 24500, 'CE');
    expect(sym.startsWith('NSE:')).toBe(true);
    expect(sym).toContain('NIFTY');
    expect(sym.endsWith('CE')).toBe(true);
  });

  it('BANKNIFTY uses NSE: prefix', () => {
    const sym = buildOptionSymbol('BANKNIFTY', expiry, 52000, 'CE');
    expect(sym.startsWith('NSE:')).toBe(true);
    expect(sym).toContain('BANKNIFTY');
    expect(sym.endsWith('CE')).toBe(true);
  });

  it('SENSEX uses BSE: prefix', () => {
    const sym = buildOptionSymbol('SENSEX', expiry, 80000, 'CE');
    // Critical correctness: Sensex options are listed on BSE, not NSE
    expect(sym.startsWith('BSE:')).toBe(true);
    expect(sym).toContain('SENSEX');
    expect(sym.endsWith('CE')).toBe(true);
  });

  it('SENSEX does NOT use NSE: prefix', () => {
    const sym = buildOptionSymbol('SENSEX', expiry, 80000, 'PE');
    expect(sym.startsWith('NSE:')).toBe(false);
  });

  it('NIFTY does NOT use BSE: prefix', () => {
    const sym = buildOptionSymbol('NIFTY', expiry, 24500, 'PE');
    expect(sym.startsWith('BSE:')).toBe(false);
  });

  it('BANKNIFTY does NOT use BSE: prefix', () => {
    const sym = buildOptionSymbol('BANKNIFTY', expiry, 52000, 'PE');
    expect(sym.startsWith('BSE:')).toBe(false);
  });

  it('EXCHANGE_PREFIXES map is correct', () => {
    expect(EXCHANGE_PREFIXES.NIFTY).toBe('NSE');
    expect(EXCHANGE_PREFIXES.BANKNIFTY).toBe('NSE');
    expect(EXCHANGE_PREFIXES.SENSEX).toBe('BSE');
  });

  it('NIFTY symbol format matches expected pattern', () => {
    // NSE:NIFTY26528024500CE
    // expiry 2026-05-28 → yy=26, month=5→'5', dd=28 → '26528'
    const expiryStr = formatFyersExpiry(expiry);
    expect(buildOptionSymbol('NIFTY', expiry, 24500, 'CE')).toBe(
      `NSE:NIFTY${expiryStr}24500CE`,
    );
  });

  it('SENSEX symbol format matches expected pattern', () => {
    const expiryStr = formatFyersExpiry(expiry);
    expect(buildOptionSymbol('SENSEX', expiry, 80000, 'CE')).toBe(
      `BSE:SENSEX${expiryStr}80000CE`,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Calendar-driven expiry (getCurrentExpiryFromCalendar)
// ---------------------------------------------------------------------------

describe('getCurrentExpiryFromCalendar', () => {
  it('returns the nearest future expiry date for NIFTY', async () => {
    // Calendar returns 2026-05-28 (nearest Thursday from 2026-05-25)
    const db = makeDbMock({ futureExpiry: '2026-05-28', maxExpiry: '2026-07-23' });
    const result = await getCurrentExpiryFromCalendar('NIFTY', db, MON_CLOCK);

    // The returned Date must represent 2026-05-28
    expect(result.getUTCFullYear()).toBe(2026);
    expect(result.getUTCMonth()).toBe(4); // May = index 4
    expect(result.getUTCDate()).toBe(28);
  });

  it('returns correct expiry for BANKNIFTY (Wednesday expiry)', async () => {
    // BANKNIFTY expires on Wednesdays — 2026-05-27
    const db = makeDbMock({ futureExpiry: '2026-05-27', maxExpiry: '2026-07-22' });
    const result = await getCurrentExpiryFromCalendar('BANKNIFTY', db, MON_CLOCK);

    expect(result.getUTCDate()).toBe(27);
    expect(result.getUTCMonth()).toBe(4);
  });

  it('returns correct expiry for SENSEX (Friday expiry)', async () => {
    // SENSEX expires on Fridays — 2026-05-29
    const db = makeDbMock({ futureExpiry: '2026-05-29', maxExpiry: '2026-07-24' });
    const result = await getCurrentExpiryFromCalendar('SENSEX', db, MON_CLOCK);

    expect(result.getUTCDate()).toBe(29);
    expect(result.getUTCMonth()).toBe(4);
  });

  it('honors holiday-shifted rows — returns the shifted date as-is', async () => {
    // A holiday-shifted row has already been adjusted to the correct trading date.
    // If the expiry_date is 2026-06-03 (holiday shifted), we return it unchanged.
    const db = makeDbMock({ futureExpiry: '2026-06-03', maxExpiry: '2026-07-22' });
    const result = await getCurrentExpiryFromCalendar('NIFTY', db, MON_CLOCK);

    expect(result.getUTCDate()).toBe(3);
    expect(result.getUTCMonth()).toBe(5); // June = index 5
  });

  it('throws CalendarExpiredError when no future expiry exists', async () => {
    // Empty calendar — no future rows
    const db = makeDbMock({ futureExpiry: null });
    await expect(
      getCurrentExpiryFromCalendar('NIFTY', db, MON_CLOCK),
    ).rejects.toThrow(CalendarExpiredError);
  });

  it('throws CalendarExpiredError with the correct underlying name', async () => {
    const db = makeDbMock({ futureExpiry: null });
    let caughtErr: unknown;
    try {
      await getCurrentExpiryFromCalendar('BANKNIFTY', db, MON_CLOCK);
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(CalendarExpiredError);
    expect((caughtErr as CalendarExpiredError).underlying).toBe('BANKNIFTY');
    expect((caughtErr as CalendarExpiredError).todayIST).toBe('2026-05-25');
  });

  it('passes the underlying and today IST date as SQL parameters', async () => {
    const db = makeDbMock({ futureExpiry: '2026-05-28' });
    await getCurrentExpiryFromCalendar('NIFTY', db, MON_CLOCK);

    const calls = (db.query as ReturnType<typeof vi.fn>).mock.calls;
    // The first call should have underlying='NIFTY' and date='2026-05-25'
    expect(calls[0]?.[1]).toContain('NIFTY');
    expect(calls[0]?.[1]).toContain('2026-05-25');
  });
});

// ---------------------------------------------------------------------------
// 3. assertCalendarFreshness — hard-fail + refill reminder
// ---------------------------------------------------------------------------

describe('assertCalendarFreshness', () => {
  afterEach(() => {
    delete process.env.CALENDAR_REFILL_DAYS;
    vi.restoreAllMocks();
  });

  it('passes silently when future expiry exists and max date is far away', async () => {
    // Max expiry 2026-07-23 is 59 days from 2026-05-25 — well beyond 14-day threshold
    const db = makeDbMock({ futureExpiry: '2026-05-28', maxExpiry: '2026-07-23' });
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      assertCalendarFreshness('NIFTY', db, MON_CLOCK),
    ).resolves.toBeUndefined();

    // No refill warning should fire
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('CALENDAR REFILL REMINDER'),
    );
  });

  it('throws CalendarExpiredError (HARD FAIL) when no future expiry exists', async () => {
    // Calendar expired — no rows at all
    const db = makeDbMock({ futureExpiry: null, maxExpiry: null });

    await expect(
      assertCalendarFreshness('NIFTY', db, MON_CLOCK),
    ).rejects.toThrow(CalendarExpiredError);
  });

  it('HARD FAIL check is independent of the refill check (expired triggers before max query)', async () => {
    // When no future expiry exists, the second query (MAX) should never run
    const db = makeDbMock({ futureExpiry: null, maxExpiry: '2026-05-26' });
    const queryMock = db.query as ReturnType<typeof vi.fn>;

    try {
      await assertCalendarFreshness('NIFTY', db, MON_CLOCK);
    } catch {
      // Expected
    }

    // Only one DB call — the hard-fail check. The refill check is never reached.
    const limitedCalls = queryMock.mock.calls.filter(
      (call) => (call[0] as string).includes('LIMIT 1'),
    );
    const maxCalls = queryMock.mock.calls.filter(
      (call) => (call[0] as string).includes('MAX(expiry_date)'),
    );
    expect(limitedCalls.length).toBeGreaterThanOrEqual(1);
    // Exact count depends on the query routing in the mock — what matters is
    // the MAX query is called 0 times (refill check skipped after hard-fail throw)
    expect(maxCalls.length).toBe(0);
  });

  it('emits refill reminder (SEPARATE from hard-fail) when max expiry is within default threshold', async () => {
    // Max expiry 2026-06-04 is 10 days from 2026-05-25 — within 14-day default
    const db = makeDbMock({ futureExpiry: '2026-05-28', maxExpiry: '2026-06-04' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await assertCalendarFreshness('NIFTY', db, MON_CLOCK);

    // Refill reminder should fire
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CALENDAR REFILL REMINDER'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('NIFTY'),
    );
  });

  it('does NOT emit refill reminder when max expiry is outside threshold (boundary)', async () => {
    // Max expiry exactly 14 days away (threshold = 14 days).
    // Date arithmetic: 2026-05-25 + 14 days = 2026-06-08.
    // daysRemaining = 14 → condition is <= 14 → warning fires at exactly 14.
    // So 15 days away should NOT trigger.
    const db = makeDbMock({ futureExpiry: '2026-05-28', maxExpiry: '2026-06-09' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await assertCalendarFreshness('NIFTY', db, MON_CLOCK);

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('CALENDAR REFILL REMINDER'),
    );
  });

  it('uses CALENDAR_REFILL_DAYS env var for the threshold', async () => {
    process.env.CALENDAR_REFILL_DAYS = '30';
    // Max expiry 25 days away — inside 30-day threshold, so warning should fire
    const db = makeDbMock({ futureExpiry: '2026-05-28', maxExpiry: '2026-06-19' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await assertCalendarFreshness('NIFTY', db, MON_CLOCK);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CALENDAR REFILL REMINDER'),
    );
  });

  it('does not throw when future expiry exists, even with refill reminder', async () => {
    // Both checks pass (no throw) even when refill reminder fires
    const db = makeDbMock({ futureExpiry: '2026-05-28', maxExpiry: '2026-05-30' });

    // Should not throw
    await expect(
      assertCalendarFreshness('NIFTY', db, MON_CLOCK),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. validateSimSymbol — structural fixture for SIM mode
// ---------------------------------------------------------------------------

describe('validateSimSymbol', () => {
  // Use expiry 2026-05-28 → formatFyersExpiry gives '26528' (yy=26, month=5='5', dd=28)
  const expiry = new Date('2026-05-28T00:00:00.000Z');

  it('validates a correct NIFTY CE symbol', () => {
    const sym = buildOptionSymbol('NIFTY', expiry, 24500, 'CE');
    // sym = 'NSE:NIFTY2652824500CE'
    expect(validateSimSymbol('NIFTY', sym)).toBe(true);
  });

  it('validates a correct NIFTY PE symbol', () => {
    const sym = buildOptionSymbol('NIFTY', expiry, 24500, 'PE');
    expect(validateSimSymbol('NIFTY', sym)).toBe(true);
  });

  it('validates a correct BANKNIFTY symbol', () => {
    const sym = buildOptionSymbol('BANKNIFTY', expiry, 52000, 'CE');
    // sym = 'NSE:BANKNIFTY2652852000CE'
    expect(validateSimSymbol('BANKNIFTY', sym)).toBe(true);
  });

  it('validates a correct SENSEX symbol with BSE: prefix', () => {
    const sym = buildOptionSymbol('SENSEX', expiry, 80000, 'CE');
    // sym = 'BSE:SENSEX2652880000CE'
    expect(validateSimSymbol('SENSEX', sym)).toBe(true);
  });

  it('rejects SENSEX symbol with wrong NSE: prefix', () => {
    // If someone builds a symbol with NSE: prefix for SENSEX, it should fail
    const wrongPrefix = 'NSE:SENSEX2652880000CE';
    expect(validateSimSymbol('SENSEX', wrongPrefix)).toBe(false);
  });

  it('rejects NIFTY symbol with wrong BSE: prefix', () => {
    const wrongPrefix = 'BSE:NIFTY2652824500CE';
    expect(validateSimSymbol('NIFTY', wrongPrefix)).toBe(false);
  });

  it('rejects symbol with wrong underlying in the string', () => {
    // NIFTY symbol that contains BANKNIFTY
    expect(validateSimSymbol('NIFTY', 'NSE:BANKNIFTY2652852000CE')).toBe(false);
  });

  it('rejects symbol with invalid option type suffix', () => {
    const badSuffix = 'NSE:NIFTY2652824500XX';
    expect(validateSimSymbol('NIFTY', badSuffix)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateSimSymbol('NIFTY', '')).toBe(false);
  });

  it('validates October expiry (month code O) for NIFTY', () => {
    // October 2026: month code = 'O', dd=16
    const octExpiry = new Date('2026-10-15T00:00:00.000Z');
    const sym = buildOptionSymbol('NIFTY', octExpiry, 25000, 'CE');
    // sym contains 'O' for month — regex uses [\\dOND] to match Oct/Nov/Dec codes
    expect(validateSimSymbol('NIFTY', sym)).toBe(true);
  });

  it('validates November expiry (month code N) for BANKNIFTY', () => {
    const novExpiry = new Date('2026-11-05T00:00:00.000Z');
    const sym = buildOptionSymbol('BANKNIFTY', novExpiry, 50000, 'PE');
    expect(validateSimSymbol('BANKNIFTY', sym)).toBe(true);
  });

  it('validates December expiry (month code D) for SENSEX', () => {
    const decExpiry = new Date('2026-12-04T00:00:00.000Z');
    const sym = buildOptionSymbol('SENSEX', decExpiry, 82000, 'CE');
    expect(validateSimSymbol('SENSEX', sym)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. CalendarExpiredError — error shape
// ---------------------------------------------------------------------------

describe('CalendarExpiredError', () => {
  it('is an instance of Error', () => {
    const err = new CalendarExpiredError('NIFTY', '2026-05-25');
    expect(err).toBeInstanceOf(Error);
  });

  it('has the correct name', () => {
    const err = new CalendarExpiredError('NIFTY', '2026-05-25');
    expect(err.name).toBe('CalendarExpiredError');
  });

  it('exposes underlying and todayIST', () => {
    const err = new CalendarExpiredError('BANKNIFTY', '2026-06-01');
    expect(err.underlying).toBe('BANKNIFTY');
    expect(err.todayIST).toBe('2026-06-01');
  });

  it('message contains the underlying name and date', () => {
    const err = new CalendarExpiredError('SENSEX', '2026-05-25');
    expect(err.message).toContain('SENSEX');
    expect(err.message).toContain('2026-05-25');
    expect(err.message).toContain('HARD FAIL');
  });
});
