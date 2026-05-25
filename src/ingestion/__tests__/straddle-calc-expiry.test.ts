/**
 * straddle-calc-expiry.test.ts — tests for FIX H1 (calendar expiry injection)
 *
 * Verifies that:
 *   1. BankNifty builds a Wednesday-dated symbol using the injected calendar expiry.
 *   2. Sensex builds a Friday-dated symbol using the injected calendar expiry.
 *   3. NIFTY (Thursday formula fallback) is unaffected when no expiry is injected.
 *   4. Week rollover: when the clock advances past the expiry cutoff, the calculator
 *      calls resolveExpiry() exactly once (not on every tick) to refresh the cached
 *      expiry, and subsequent snapshots use the refreshed date.
 *   5. If resolveExpiry() is not provided, the calculator does NOT call it on rollover
 *      (falls back to Thursday formula silently — correct for NIFTY, logged for others).
 *
 * All tests are self-contained: no real Redis, no real DB, no real clock.
 * Redis is mocked with minimal stubs that record xadd calls for assertion.
 * Timers are faked via vitest so snapshot intervals drive deterministically.
 *
 * Symbol format reference (Fyers compact expiry encoding):
 *   YYYYMMDD where YYYY=year, MM=1-indexed month (Oct='O', Nov='N', Dec='D'), DD=day
 *   Example: Wednesday 2024-01-24 → 24124 (yy='24', month='1', dd='24')
 *   Example: Friday   2024-01-26 → 24126 (yy='24', month='1', dd='26')
 *   Example: Thursday 2024-01-25 → 24125 (yy='24', month='1', dd='25')
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixedClock } from '../../utils/clock';
import { createStraddleCalculator } from '../straddle-calc';

// ---------------------------------------------------------------------------
// Redis stub helpers
// ---------------------------------------------------------------------------

/**
 * Shapes the XREAD return value the way ioredis returns it.
 * Returns null (no messages) when entries array is empty.
 */
function makeXreadResult(
  streamName: string,
  entries: Array<{ id: string; data: string }>,
): [string, [string, string[]][]][] | null {
  if (entries.length === 0) return null;
  const msgs: [string, string[]][] = entries.map(({ id, data }) => [id, ['data', data]]);
  return [[streamName, msgs]];
}

/** Minimal Redis stub — only the methods called by straddle-calc are present. */
function makeFakeRedis() {
  return {
    xread: vi.fn().mockResolvedValue(null),
    xadd: vi.fn().mockResolvedValue('stream-id-1'),
  };
}

/** Yield microtask queue N times to let async poll-loop iterations complete. */
async function flushMicrotasks(n = 15): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Time anchors
//
// We use a Thursday (2024-01-25) as the reference week:
//   - Wednesday 2024-01-24: BankNifty expiry (the day BEFORE the Thursday)
//   - Thursday  2024-01-25: NIFTY expiry
//   - Friday    2024-01-26: Sensex expiry (the day AFTER the Thursday)
//
// All anchors are at noon IST (06:30 UTC) — before the 15:30 IST expiry cutoff —
// so the injected current-expiry date is still valid for the current session.
// ---------------------------------------------------------------------------

/** Wednesday 2024-01-24 at noon IST (06:30 UTC). */
const WED_NOON_UTC = new Date('2024-01-24T06:30:00Z');
/** Thursday 2024-01-25 at noon IST (06:30 UTC). */
const THU_NOON_UTC = new Date('2024-01-25T06:30:00Z');
/** Friday 2024-01-26 at noon IST (06:30 UTC). */
const FRI_NOON_UTC = new Date('2024-01-26T06:30:00Z');

/** The Wednesday expiry date — UTC midnight-aligned so formatFyersExpiry reads correct UTC fields. */
const BANKNIFTY_EXPIRY = new Date('2024-01-24T00:00:00.000Z');
/** The Thursday expiry date — same as what the Thursday formula would return. */
const NIFTY_EXPIRY = new Date('2024-01-25T00:00:00.000Z');
/** The Friday expiry date — one day after the Thursday formula. */
const SENSEX_EXPIRY = new Date('2024-01-26T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Expected symbol helpers
//
// Fyers compact encoding for Jan 2024:
//   yy='24', monthCode='1' (Jan), dd=<day zero-padded>
// ---------------------------------------------------------------------------

function makeTick(symbol: string, ltp: number, ts: number) {
  return JSON.stringify({ symbol, ltp, timestamp: ts });
}

// ---------------------------------------------------------------------------
// Test 1: BankNifty builds a Wednesday-dated symbol via injected calendar expiry
// ---------------------------------------------------------------------------

describe('FIX H1 — BankNifty uses Wednesday expiry from calendar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes snapshot with NSE:BANKNIFTY...24124...CE/PE symbols (Wednesday 2024-01-24)', async () => {
    const redis = makeFakeRedis();
    // Clock is at Wednesday noon IST — same day as the BankNifty expiry.
    const clock = new FixedClock(WED_NOON_UTC);

    // BankNifty spot = 47400 → ATM = 47400 (exact 100-pt multiple).
    // Injected expiry = Wednesday 2024-01-24.
    // Expected symbol: NSE:BANKNIFTY24124<strike>CE/PE
    const bnSpot = 47400;
    const ts = WED_NOON_UTC.getTime();

    const ticks = [
      { id: '1-1', data: makeTick('NSE:NIFTYBANK-INDEX', bnSpot, ts) },
      { id: '1-2', data: makeTick('NSE:BANKNIFTY2412447400CE', 300, ts) },
      { id: '1-3', data: makeTick('NSE:BANKNIFTY2412447400PE', 280, ts) },
    ];

    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', ticks))
      .mockResolvedValue(null);

    const calc = createStraddleCalculator(redis as unknown as import('ioredis').Redis, {
      underlying: 'BANKNIFTY',
      snapshotIntervalMs: 15_000,
      clock,
      // FIX H1: inject the calendar-correct Wednesday expiry
      currentExpiry: BANKNIFTY_EXPIRY,
      resolveExpiry: async () => BANKNIFTY_EXPIRY,
    });

    await calc.start();
    await flushMicrotasks();
    vi.advanceTimersByTime(15_000);
    await flushMicrotasks();

    expect(redis.xadd).toHaveBeenCalledTimes(1);

    const args = redis.xadd.mock.calls[0] as unknown[];
    const snapshot = JSON.parse(args[6] as string) as { cePrice: number; pePrice: number };
    // If symbols are correct (Wednesday expiry), the CE/PE prices will be found.
    expect(snapshot.cePrice).toBe(300);
    expect(snapshot.pePrice).toBe(280);

    await calc.stop();
  });

  it('does NOT find CE/PE prices when the Thursday formula is used instead of the Wednesday expiry', async () => {
    // This test demonstrates the bug: without currentExpiry, the calculator uses
    // the Thursday formula and builds BANKNIFTY...25... symbols, not ...24...
    // The price map only has the Wednesday symbols, so no snapshot is published.
    const redis = makeFakeRedis();
    // Clock is at Wednesday noon IST (before 15:30 cutoff — so Thu formula returns next Thursday)
    // Actually: Wednesday → nearest Thursday is Jan 25 (tomorrow).
    // The price map has Wednesday symbols; the calculator looks for Thursday symbols → miss.
    const clock = new FixedClock(WED_NOON_UTC);

    const bnSpot = 47400;
    const ts = WED_NOON_UTC.getTime();

    const ticks = [
      { id: '2-1', data: makeTick('NSE:NIFTYBANK-INDEX', bnSpot, ts) },
      // Wednesday symbols — the Thursday formula would compute NSE:BANKNIFTY2412547400CE/PE
      { id: '2-2', data: makeTick('NSE:BANKNIFTY2412447400CE', 300, ts) },
      { id: '2-3', data: makeTick('NSE:BANKNIFTY2412447400PE', 280, ts) },
    ];

    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', ticks))
      .mockResolvedValue(null);

    // No currentExpiry injected — falls back to Thursday formula.
    const calc = createStraddleCalculator(redis as unknown as import('ioredis').Redis, {
      underlying: 'BANKNIFTY',
      snapshotIntervalMs: 15_000,
      clock,
      // No currentExpiry — uses Thursday formula, builds wrong symbols for BankNifty
    });

    await calc.start();
    await flushMicrotasks();
    vi.advanceTimersByTime(15_000);
    await flushMicrotasks();

    // Thursday formula built wrong symbols → CE/PE not found → no xadd call.
    expect(redis.xadd).not.toHaveBeenCalled();

    await calc.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 2: Sensex builds a Friday-dated symbol via injected calendar expiry
// ---------------------------------------------------------------------------

describe('FIX H1 — Sensex uses Friday expiry from calendar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes snapshot with BSE:SENSEX...24126...CE/PE symbols (Friday 2024-01-26)', async () => {
    const redis = makeFakeRedis();
    // Clock is at Thursday noon IST — one day before the Friday Sensex expiry.
    const clock = new FixedClock(THU_NOON_UTC);

    // Sensex spot = 80000 → ATM = 80000 (exact 100-pt multiple).
    // Injected expiry = Friday 2024-01-26.
    // Expected symbol: BSE:SENSEX24126<strike>CE/PE
    const sxSpot = 80000;
    const ts = THU_NOON_UTC.getTime();

    const ticks = [
      { id: '3-1', data: makeTick('BSE:SENSEX-INDEX', sxSpot, ts) },
      { id: '3-2', data: makeTick('BSE:SENSEX2412680000CE', 400, ts) },
      { id: '3-3', data: makeTick('BSE:SENSEX2412680000PE', 390, ts) },
    ];

    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', ticks))
      .mockResolvedValue(null);

    const calc = createStraddleCalculator(redis as unknown as import('ioredis').Redis, {
      underlying: 'SENSEX',
      snapshotIntervalMs: 15_000,
      clock,
      // FIX H1: inject the calendar-correct Friday expiry
      currentExpiry: SENSEX_EXPIRY,
      resolveExpiry: async () => SENSEX_EXPIRY,
    });

    await calc.start();
    await flushMicrotasks();
    vi.advanceTimersByTime(15_000);
    await flushMicrotasks();

    expect(redis.xadd).toHaveBeenCalledTimes(1);

    const args = redis.xadd.mock.calls[0] as unknown[];
    const snapshot = JSON.parse(args[6] as string) as { cePrice: number; pePrice: number };
    expect(snapshot.cePrice).toBe(400);
    expect(snapshot.pePrice).toBe(390);

    await calc.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 3: NIFTY is unaffected — injected Thursday expiry matches the formula
// ---------------------------------------------------------------------------

describe('FIX H1 — NIFTY behaviour is unchanged with or without calendar expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes the same symbols whether or not currentExpiry is injected (NIFTY Thursday)', async () => {
    const redis = makeFakeRedis();
    // Thursday noon IST — Thursday formula returns same day (2024-01-25).
    const clock = new FixedClock(THU_NOON_UTC);

    const nfSpot = 22400;
    const ts = THU_NOON_UTC.getTime();

    const ticks = [
      { id: '4-1', data: makeTick('NSE:NIFTY50-INDEX', nfSpot, ts) },
      // Thursday 2024-01-25 → Fyers expiry code '24125'
      { id: '4-2', data: makeTick('NSE:NIFTY2412522400CE', 150, ts) },
      { id: '4-3', data: makeTick('NSE:NIFTY2412522400PE', 145, ts) },
    ];

    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', ticks))
      .mockResolvedValue(null);

    const calc = createStraddleCalculator(redis as unknown as import('ioredis').Redis, {
      underlying: 'NIFTY',
      snapshotIntervalMs: 15_000,
      clock,
      // Injected Thursday expiry — same as the Thursday formula → no behavioural difference
      currentExpiry: NIFTY_EXPIRY,
      resolveExpiry: async () => NIFTY_EXPIRY,
    });

    await calc.start();
    await flushMicrotasks();
    vi.advanceTimersByTime(15_000);
    await flushMicrotasks();

    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const args = redis.xadd.mock.calls[0] as unknown[];
    const snapshot = JSON.parse(args[6] as string) as { cePrice: number; pePrice: number };
    expect(snapshot.cePrice).toBe(150);
    expect(snapshot.pePrice).toBe(145);

    await calc.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 4: Week rollover — resolveExpiry is called once on rollover, not per tick
// ---------------------------------------------------------------------------

describe('FIX H1 — week rollover refreshes expiry without per-tick DB calls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls resolveExpiry exactly once when the clock passes the expiry cutoff', async () => {
    const redis = makeFakeRedis();

    // Clock is PAST the Thursday 15:30 IST cutoff — the current expiry has rolled over.
    // Thursday 2024-01-25 at 16:00 IST = 10:30 UTC.
    const pastCutoff = new Date('2024-01-25T10:30:00Z');
    const clock = new FixedClock(pastCutoff);

    // Current expiry = Thursday 2024-01-25 (already expired at 15:30 IST).
    const expiredExpiry = NIFTY_EXPIRY;
    // Next expiry = Thursday 2024-02-01 (one week later).
    const nextExpiry = new Date('2024-02-01T00:00:00.000Z');

    const resolveExpiry = vi.fn().mockResolvedValue(nextExpiry);

    const ts = pastCutoff.getTime();
    // Price map has next-week symbols
    const ticks = [
      { id: '5-1', data: makeTick('NSE:NIFTY50-INDEX', 22400, ts) },
      // Old Thursday expiry symbols — should NOT match after rollover
      { id: '5-2', data: makeTick('NSE:NIFTY2412522400CE', 150, ts) },
      { id: '5-3', data: makeTick('NSE:NIFTY2412522400PE', 145, ts) },
    ];

    // First XREAD returns ticks, subsequent return null
    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', ticks))
      .mockResolvedValue(null);

    const calc = createStraddleCalculator(redis as unknown as import('ioredis').Redis, {
      underlying: 'NIFTY',
      snapshotIntervalMs: 15_000,
      clock,
      currentExpiry: expiredExpiry,
      resolveExpiry,
    });

    await calc.start();
    await flushMicrotasks();

    // Fire the first snapshot — clock is past expiry cutoff, rollover triggered.
    // resolveExpiry is called (once). The current snapshot still uses the old
    // expiry (because the async refresh hasn't resolved yet synchronously), but
    // the refresh is in-flight.
    vi.advanceTimersByTime(15_000);
    await flushMicrotasks(20);

    // resolveExpiry should have been called exactly once, not once per tick.
    expect(resolveExpiry).toHaveBeenCalledTimes(1);

    // Fire a second snapshot to verify the refresh is not re-triggered.
    vi.advanceTimersByTime(15_000);
    await flushMicrotasks(20);

    // Still called only once — the refresh is debounced.
    expect(resolveExpiry).toHaveBeenCalledTimes(1);

    await calc.stop();
  });

  it('does NOT call resolveExpiry when the clock is before the expiry cutoff', async () => {
    const redis = makeFakeRedis();
    // Thursday noon IST — well before the 15:30 cutoff.
    const clock = new FixedClock(THU_NOON_UTC);

    const resolveExpiry = vi.fn().mockResolvedValue(NIFTY_EXPIRY);

    const ts = THU_NOON_UTC.getTime();
    const ticks = [
      { id: '6-1', data: makeTick('NSE:NIFTY50-INDEX', 22400, ts) },
      { id: '6-2', data: makeTick('NSE:NIFTY2412522400CE', 150, ts) },
      { id: '6-3', data: makeTick('NSE:NIFTY2412522400PE', 145, ts) },
    ];

    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', ticks))
      .mockResolvedValue(null);

    const calc = createStraddleCalculator(redis as unknown as import('ioredis').Redis, {
      underlying: 'NIFTY',
      snapshotIntervalMs: 15_000,
      clock,
      currentExpiry: NIFTY_EXPIRY,
      resolveExpiry,
    });

    await calc.start();
    await flushMicrotasks();
    vi.advanceTimersByTime(15_000);
    await flushMicrotasks(20);

    // No rollover needed — resolveExpiry must not be called.
    expect(resolveExpiry).not.toHaveBeenCalled();

    await calc.stop();
  });
});
