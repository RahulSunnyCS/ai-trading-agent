/**
 * Unit tests for expiry-resolver.ts
 *
 * All tests use a mocked fetchFn so no real network calls are made.
 *
 * Tests cover:
 *   1. Happy path — picks the nearest today-or-future expiry from Fyers data.
 *   2. 15:30 IST cut-off — skips today's expiry when market is closed.
 *   3. Fallback on fetch failure (network error).
 *   4. Fallback when Fyers returns s !== "ok".
 *   5. Fallback when expiryData is empty.
 *   6. Cache: returns the same Date on the second call without hitting fetch.
 *   7. clearExpiryCache: subsequent calls re-hit fetch after cache is cleared.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FixedClock } from '../../../utils/clock.js';
import type { FetchFn } from '../fyers-historical.js';
import { clearExpiryCache, resolveCurrentExpiry } from '../expiry-resolver.js';
import { getCurrentExpiry } from '../instrument-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Fyers option-chain response body containing the given
 * expiry epoch-seconds values. Fyers returns expiryData sorted ascending.
 */
function makeFyersResponse(epochSecondsList: number[]): unknown {
  return {
    s: 'ok',
    data: {
      expiryData: epochSecondsList.map((epoch) => ({
        date: new Date(epoch * 1000).toISOString().slice(0, 10).split('-').reverse().join('-'), // DD-MM-YYYY
        expiry: String(epoch),
      })),
    },
  };
}

/**
 * Create a fetchFn mock that returns the given JSON response body.
 */
function makeFetchFn(body: unknown, status = 200): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

/**
 * Create a fetchFn mock that rejects with a network error.
 */
function makeNetworkErrorFetchFn(): FetchFn {
  return vi.fn().mockRejectedValue(new Error('Network failure'));
}

// Tuesday 2024-01-23 at noon IST (06:30 UTC) — NIFTY expiry day, before cut-off.
const TUE_NOON_UTC = new Date('2024-01-23T06:30:00Z');

// Tuesday 2024-01-23 at 16:00 IST (10:30 UTC) — past the 15:30 cut-off.
const TUE_PAST_EOD_UTC = new Date('2024-01-23T10:30:00Z');

// Next Tuesday: 2024-01-30 (epoch seconds at midnight UTC).
const NEXT_TUE_ISO = '2024-01-30';
const NEXT_TUE_EPOCH_SEC = new Date('2024-01-30T00:00:00Z').getTime() / 1000;

// This Tuesday: 2024-01-23 (epoch seconds at midnight UTC).
const THIS_TUE_ISO = '2024-01-23';
const THIS_TUE_EPOCH_SEC = new Date('2024-01-23T00:00:00Z').getTime() / 1000;

const CREDENTIALS = { appId: 'TESTAPP-100', accessToken: 'tok123' };

// ---------------------------------------------------------------------------
// Before each: clear the in-process cache to prevent cross-test pollution.
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearExpiryCache();
});

// ---------------------------------------------------------------------------
// 1. Happy path — picks the nearest today-or-future expiry
// ---------------------------------------------------------------------------

describe('resolveCurrentExpiry — happy path', () => {
  it('returns the nearest future expiry from Fyers data when today is not expiry day', async () => {
    // Clock: Monday 2024-01-22 noon IST. Fyers returns next two Tuesdays.
    const clock = new FixedClock(new Date('2024-01-22T06:30:00Z')); // Monday

    const fetchFn = makeFetchFn(
      makeFyersResponse([THIS_TUE_EPOCH_SEC, NEXT_TUE_EPOCH_SEC]),
    );

    const result = await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });

    // Should pick 2024-01-23 (this Tuesday — the nearest one on or after today)
    expect(result.toISOString().slice(0, 10)).toBe(THIS_TUE_ISO);
  });

  it('returns today when today is expiry day and before 15:30 IST', async () => {
    // Clock: Tuesday 2024-01-23 at noon IST (06:30 UTC).
    const clock = new FixedClock(TUE_NOON_UTC);

    const fetchFn = makeFetchFn(
      makeFyersResponse([THIS_TUE_EPOCH_SEC, NEXT_TUE_EPOCH_SEC]),
    );

    const result = await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });
    expect(result.toISOString().slice(0, 10)).toBe(THIS_TUE_ISO);
  });

  it('returns a midnight UTC Date (time components zeroed)', async () => {
    const clock = new FixedClock(TUE_NOON_UTC);
    const fetchFn = makeFetchFn(makeFyersResponse([THIS_TUE_EPOCH_SEC]));

    const result = await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 15:30 IST cut-off — skips today's expiry when market is closed
// ---------------------------------------------------------------------------

describe('resolveCurrentExpiry — 15:30 IST cut-off', () => {
  it('skips today and returns next expiry when current IST time >= 15:30', async () => {
    // Clock: Tuesday 2024-01-23 at 16:00 IST (10:30 UTC) — past cut-off.
    const clock = new FixedClock(TUE_PAST_EOD_UTC);

    const fetchFn = makeFetchFn(
      makeFyersResponse([THIS_TUE_EPOCH_SEC, NEXT_TUE_EPOCH_SEC]),
    );

    const result = await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });
    // Today's expiry is closed → should return next Tuesday 2024-01-30.
    expect(result.toISOString().slice(0, 10)).toBe(NEXT_TUE_ISO);
  });

  it('returns today at exactly 15:29 IST (one minute before cut-off)', async () => {
    // 2024-01-23T09:59:00Z = 15:29 IST — still open.
    const clock = new FixedClock(new Date('2024-01-23T09:59:00Z'));
    const fetchFn = makeFetchFn(makeFyersResponse([THIS_TUE_EPOCH_SEC, NEXT_TUE_EPOCH_SEC]));

    const result = await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });
    expect(result.toISOString().slice(0, 10)).toBe(THIS_TUE_ISO);
  });
});

// ---------------------------------------------------------------------------
// 3. Fallback on network error — never throws
// ---------------------------------------------------------------------------

describe('resolveCurrentExpiry — fallback on failure', () => {
  it('falls back to getCurrentExpiry() on network error and does not throw', async () => {
    const clock = new FixedClock(TUE_NOON_UTC);
    const fetchFn = makeNetworkErrorFetchFn();

    // Should NOT throw — must return the local fallback.
    const result = await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });

    // The fallback uses getCurrentExpiry('NIFTY', clock) which on Tuesday noon IST
    // returns 2024-01-23 (same-day Tuesday).
    const expected = getCurrentExpiry('NIFTY', clock);
    expect(result.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it('falls back when Fyers returns s !== "ok"', async () => {
    const clock = new FixedClock(TUE_NOON_UTC);
    const fetchFn = makeFetchFn({ s: 'error', message: 'token expired' });

    const result = await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });
    const expected = getCurrentExpiry('NIFTY', clock);
    expect(result.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it('falls back when expiryData is empty', async () => {
    const clock = new FixedClock(TUE_NOON_UTC);
    const fetchFn = makeFetchFn({ s: 'ok', data: { expiryData: [] } });

    const result = await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });
    const expected = getCurrentExpiry('NIFTY', clock);
    expect(result.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it('falls back when HTTP status is non-OK (e.g. 401)', async () => {
    const clock = new FixedClock(TUE_NOON_UTC);
    const fetchFn = makeFetchFn({}, 401);

    const result = await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });
    const expected = getCurrentExpiry('NIFTY', clock);
    expect(result.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it('falls back when expiryData entries have malformed epoch values', async () => {
    const clock = new FixedClock(TUE_NOON_UTC);
    const fetchFn = makeFetchFn({
      s: 'ok',
      data: {
        expiryData: [
          { date: '23-01-2024', expiry: 'not-a-number' },
          { date: '30-01-2024', expiry: null },
        ],
      },
    });

    // All entries are malformed → falls back to getCurrentExpiry()
    const result = await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });
    const expected = getCurrentExpiry('NIFTY', clock);
    expect(result.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });
});

// ---------------------------------------------------------------------------
// 4. Cache behaviour
// ---------------------------------------------------------------------------

describe('resolveCurrentExpiry — in-process cache', () => {
  it('returns the cached value on the second call without calling fetch again', async () => {
    const clock = new FixedClock(TUE_NOON_UTC);
    const fetchFn = makeFetchFn(makeFyersResponse([THIS_TUE_EPOCH_SEC, NEXT_TUE_EPOCH_SEC]));

    // First call: hits Fyers.
    const result1 = await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });
    // Second call on the same IST day: should return the cache without calling fetch.
    const result2 = await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });

    expect(result1.toISOString()).toBe(result2.toISOString());
    // fetchFn must have been called only once (the second call used the cache).
    expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(1);
  });

  it('hits fetch again after clearExpiryCache()', async () => {
    const clock = new FixedClock(TUE_NOON_UTC);
    const fetchFn = makeFetchFn(makeFyersResponse([THIS_TUE_EPOCH_SEC]));

    await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });
    clearExpiryCache();
    await resolveCurrentExpiry('NIFTY', { ...CREDENTIALS, clock, fetchFn });

    // Should have fetched twice — once before clear, once after.
    expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(2);
  });
});
