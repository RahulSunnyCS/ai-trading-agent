/**
 * Unit tests for vix-feed.ts
 *
 * Tests cover:
 *   1. VIX reading is null before first data
 *   2. Tick for NSE:INDIAVIX-INDEX updates getLatestVix() with source 'tick'
 *   3. Tick for unrelated symbol does NOT update VIX
 *   4. Poll fallback updates VIX with source 'poll' when no recent tick
 *   5. Poll fallback does NOT publish if a tick was received within 5 minutes (dedup)
 *   6. NSE API failure (fetch throws) → logged warning, VIX unchanged
 *   7. NSE API returns response without INDIA VIX element → logged warning, VIX unchanged
 *   8. Malformed JSON in tick → skip, no crash
 *
 * Redis is fully mocked — no live Redis connection is required.
 * Timers are faked via vitest so poll intervals can be driven deterministically.
 * fetch is mocked via vi.stubGlobal to avoid real network calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixedClock } from '../../utils/clock';
import { createVixFeed } from '../vix-feed';
import type { VixReading } from '../vix-feed';

// ---------------------------------------------------------------------------
// Helper: minimal Redis fake
// ---------------------------------------------------------------------------

/**
 * Shapes the XREAD return value as ioredis emits it:
 *   [ [ streamName, [ [id, [field, value, ...]], ... ] ] ]
 *
 * Returns null (no new messages) when entries is empty.
 */
function makeXreadResult(
  streamName: string,
  entries: Array<{ id: string; data: string }>,
): [string, [string, string[]][]][] | null {
  if (entries.length === 0) return null;
  const msgs: [string, string[]][] = entries.map(({ id, data }) => [id, ['data', data]]);
  return [[streamName, msgs]];
}

/** Minimal Redis fake — only the methods touched by vix-feed are implemented. */
interface FakeRedis {
  xread: ReturnType<typeof vi.fn>;
  xadd: ReturnType<typeof vi.fn>;
}

function makeFakeRedis(): FakeRedis {
  return {
    // Default: return null (no new messages). Tests override this per-call.
    xread: vi.fn().mockResolvedValue(null),
    // Default: succeed silently.
    xadd: vi.fn().mockResolvedValue('ok'),
  };
}

// ---------------------------------------------------------------------------
// Helper: build a raw JSON tick string for market.ticks stream
// ---------------------------------------------------------------------------

function makeTickData(symbol: string, ltp: number, timestamp: number): string {
  return JSON.stringify({ symbol, ltp, timestamp });
}

// ---------------------------------------------------------------------------
// Helper: flush async microtasks so the poll loop processes XREAD results
// ---------------------------------------------------------------------------

/**
 * Yields control several times so that all pending async microtasks
 * (including each `await` inside the polling loop) have a chance to execute.
 * This mirrors the pattern used in straddle-calc.test.ts.
 */
async function flushMicrotasks(count = 20): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Helper: build a valid NSE API JSON response body
// ---------------------------------------------------------------------------

function makeNseResponse(vixValue: number): unknown {
  return {
    data: [
      { index: 'NIFTY 50', last: 22400 },
      { index: 'INDIA VIX', last: vixValue },
      { index: 'BANK NIFTY', last: 47500 },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. VIX reading is null before first data
// ---------------------------------------------------------------------------

describe('createVixFeed — initial state', () => {
  it('returns null from getLatestVix() before any tick or poll arrives', () => {
    const redis = makeFakeRedis();
    const clock = new FixedClock(new Date('2024-01-25T06:30:00Z'));
    const feed = createVixFeed(redis as unknown as import('ioredis').Redis, { clock });

    expect(feed.getLatestVix()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Tick for NSE:INDIAVIX-INDEX updates getLatestVix() with source 'tick'
// ---------------------------------------------------------------------------

describe('createVixFeed — tick-based VIX', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('updates latestVix with source "tick" when NSE:INDIAVIX-INDEX tick arrives', async () => {
    const redis = makeFakeRedis();
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    const vixTickData = makeTickData('NSE:INDIAVIX-INDEX', 14.23, fixedDate.getTime());

    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', [{ id: '1-1', data: vixTickData }]))
      .mockResolvedValue(null);

    const feed = createVixFeed(redis as unknown as import('ioredis').Redis, {
      clock,
      // Use a very long poll interval so the poll fallback never fires.
      pollIntervalMs: 10_000_000,
    });

    await feed.start();
    await flushMicrotasks();

    const latest = feed.getLatestVix();
    expect(latest).not.toBeNull();
    expect(latest?.vix).toBe(14.23);
    expect(latest?.source).toBe('tick');
    expect(latest?.timestamp).toBe(fixedDate.getTime());

    await feed.stop();
  });

  it('publishes the VIX reading to the market.vix Redis stream on tick', async () => {
    const redis = makeFakeRedis();
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    const vixTickData = makeTickData('NSE:INDIAVIX-INDEX', 17.5, fixedDate.getTime());

    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', [{ id: '2-1', data: vixTickData }]))
      .mockResolvedValue(null);

    const feed = createVixFeed(redis as unknown as import('ioredis').Redis, {
      clock,
      pollIntervalMs: 10_000_000,
    });

    await feed.start();
    await flushMicrotasks();

    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const args = redis.xadd.mock.calls[0] as unknown[];
    expect(args[0]).toBe('market.vix');
    // New MAXLEN trimming args: args[1]='MAXLEN', args[2]='~', args[3]='10000'
    expect(args[1]).toBe('MAXLEN');
    expect(args[2]).toBe('~');
    expect(args[3]).toBe('10000');
    // Stream ID and field/value args follow the MAXLEN block
    expect(args[4]).toBe('*');
    expect(args[5]).toBe('data');

    const published = JSON.parse(args[6] as string) as VixReading;
    expect(published.vix).toBe(17.5);
    expect(published.source).toBe('tick');

    await feed.stop();
  });
});

// ---------------------------------------------------------------------------
// 3. Tick for unrelated symbol does NOT update VIX
// ---------------------------------------------------------------------------

describe('createVixFeed — unrelated symbol filtering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ignores ticks for symbols other than NSE:INDIAVIX-INDEX', async () => {
    const redis = makeFakeRedis();
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    // A NIFTY tick, not a VIX tick
    const unrelatedTick = makeTickData('NSE:NIFTY50-INDEX', 22400, fixedDate.getTime());

    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', [{ id: '3-1', data: unrelatedTick }]))
      .mockResolvedValue(null);

    const feed = createVixFeed(redis as unknown as import('ioredis').Redis, {
      clock,
      pollIntervalMs: 10_000_000,
    });

    await feed.start();
    await flushMicrotasks();

    // Should still be null — the unrelated tick must not update VIX.
    expect(feed.getLatestVix()).toBeNull();
    // xadd must NOT have been called.
    expect(redis.xadd).not.toHaveBeenCalled();

    await feed.stop();
  });
});

// ---------------------------------------------------------------------------
// 4. Poll fallback updates VIX with source 'poll' when no recent tick
// ---------------------------------------------------------------------------

describe('createVixFeed — NSE poll fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('publishes VIX from NSE poll with source "poll" when no tick was received', async () => {
    const redis = makeFakeRedis();
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    // No ticks — xread always returns null.
    redis.xread.mockResolvedValue(null);

    // Mock fetch to return a valid NSE API response with VIX = 15.75.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeNseResponse(15.75),
    });
    vi.stubGlobal('fetch', mockFetch);

    const feed = createVixFeed(redis as unknown as import('ioredis').Redis, {
      clock,
      pollIntervalMs: 60_000,
      // Point at a dummy URL so there's no confusion with the default.
      pollUrl: 'https://test.example.com/api/vix',
    });

    await feed.start();

    // Advance timers to trigger the poll interval.
    vi.advanceTimersByTime(60_000);
    await flushMicrotasks();

    const latest = feed.getLatestVix();
    expect(latest).not.toBeNull();
    expect(latest?.vix).toBe(15.75);
    expect(latest?.source).toBe('poll');

    // xadd must have been called once with the poll reading.
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const args = redis.xadd.mock.calls[0] as unknown[];
    // Verify MAXLEN trimming args are present
    expect(args[1]).toBe('MAXLEN');
    expect(args[2]).toBe('~');
    expect(args[3]).toBe('10000');
    // JSON payload is now at index 6 (after stream, MAXLEN, ~, 10000, *, data)
    const published = JSON.parse(args[6] as string) as VixReading;
    expect(published.source).toBe('poll');

    await feed.stop();
  });
});

// ---------------------------------------------------------------------------
// 5. Poll fallback does NOT publish if a tick was received within 5 minutes
// ---------------------------------------------------------------------------

describe('createVixFeed — poll dedup (tick freshness gate)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('suppresses poll publish when a tick arrived within the last 5 minutes', async () => {
    const redis = makeFakeRedis();
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    // Provide a VIX tick so lastTickVixTimestamp is set to fixedDate.getTime().
    const vixTickData = makeTickData('NSE:INDIAVIX-INDEX', 13.0, fixedDate.getTime());

    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', [{ id: '5-1', data: vixTickData }]))
      .mockResolvedValue(null);

    // Mock fetch — it should NOT be called because the tick is fresh.
    // But even if it is called (poll fires), we want to verify xadd is called only once.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeNseResponse(20.0),
    });
    vi.stubGlobal('fetch', mockFetch);

    const feed = createVixFeed(redis as unknown as import('ioredis').Redis, {
      clock,
      pollIntervalMs: 60_000,
      pollUrl: 'https://test.example.com/api/vix',
    });

    await feed.start();

    // Process the tick first.
    await flushMicrotasks();

    // The clock is fixed at fixedDate — so lastTickVixTimestamp = fixedDate.getTime()
    // and clock.timestamp() also returns fixedDate.getTime().
    // The difference is 0, which is less than 5 minutes — poll should be suppressed.
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const firstCallArgs = redis.xadd.mock.calls[0] as unknown[];
    // Verify MAXLEN trimming args are present
    expect(firstCallArgs[1]).toBe('MAXLEN');
    expect(firstCallArgs[2]).toBe('~');
    expect(firstCallArgs[3]).toBe('10000');
    // JSON payload is now at index 6 (after stream, MAXLEN, ~, 10000, *, data)
    const firstPublished = JSON.parse(firstCallArgs[6] as string) as VixReading;
    expect(firstPublished.source).toBe('tick');

    // Advance to trigger the poll interval.
    vi.advanceTimersByTime(60_000);
    await flushMicrotasks();

    // xadd must still only have been called once (the tick publish).
    // The poll should have been suppressed.
    expect(redis.xadd).toHaveBeenCalledTimes(1);

    await feed.stop();
  });
});

// ---------------------------------------------------------------------------
// 6. NSE API failure (fetch throws) → logged warning, VIX unchanged
// ---------------------------------------------------------------------------

describe('createVixFeed — NSE API error handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs a warning and leaves VIX unchanged when fetch throws', async () => {
    const redis = makeFakeRedis();
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    // No ticks.
    redis.xread.mockResolvedValue(null);

    // fetch throws a network error.
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network failure'));
    vi.stubGlobal('fetch', mockFetch);

    // Spy on console.warn to verify the warning is logged.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const feed = createVixFeed(redis as unknown as import('ioredis').Redis, {
      clock,
      pollIntervalMs: 60_000,
      pollUrl: 'https://test.example.com/api/vix',
    });

    await feed.start();
    vi.advanceTimersByTime(60_000);
    await flushMicrotasks();

    // VIX must remain null.
    expect(feed.getLatestVix()).toBeNull();
    // xadd must not have been called.
    expect(redis.xadd).not.toHaveBeenCalled();
    // A warning must have been logged.
    expect(warnSpy).toHaveBeenCalled();

    await feed.stop();
    warnSpy.mockRestore();
  });

  it('logs a warning and leaves VIX unchanged when HTTP status is not OK', async () => {
    const redis = makeFakeRedis();
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    redis.xread.mockResolvedValue(null);

    // fetch returns HTTP 403.
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal('fetch', mockFetch);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const feed = createVixFeed(redis as unknown as import('ioredis').Redis, {
      clock,
      pollIntervalMs: 60_000,
      pollUrl: 'https://test.example.com/api/vix',
    });

    await feed.start();
    vi.advanceTimersByTime(60_000);
    await flushMicrotasks();

    expect(feed.getLatestVix()).toBeNull();
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    await feed.stop();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 7. NSE API returns response without INDIA VIX element → warning, VIX unchanged
// ---------------------------------------------------------------------------

describe('createVixFeed — missing INDIA VIX in NSE response', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs a warning and leaves VIX unchanged when INDIA VIX entry is absent', async () => {
    const redis = makeFakeRedis();
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    redis.xread.mockResolvedValue(null);

    // NSE response that does not contain the INDIA VIX entry.
    const responseWithoutVix = {
      data: [
        { index: 'NIFTY 50', last: 22400 },
        { index: 'BANK NIFTY', last: 47500 },
        // No INDIA VIX entry
      ],
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => responseWithoutVix,
    });
    vi.stubGlobal('fetch', mockFetch);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const feed = createVixFeed(redis as unknown as import('ioredis').Redis, {
      clock,
      pollIntervalMs: 60_000,
      pollUrl: 'https://test.example.com/api/vix',
    });

    await feed.start();
    vi.advanceTimersByTime(60_000);
    await flushMicrotasks();

    expect(feed.getLatestVix()).toBeNull();
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    await feed.stop();
    warnSpy.mockRestore();
  });

  it('logs a warning and leaves VIX unchanged when NSE response has wrong shape', async () => {
    const redis = makeFakeRedis();
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    redis.xread.mockResolvedValue(null);

    // Response that has no `data` array at all.
    const malformedResponse = { error: 'service unavailable' };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => malformedResponse,
    });
    vi.stubGlobal('fetch', mockFetch);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const feed = createVixFeed(redis as unknown as import('ioredis').Redis, {
      clock,
      pollIntervalMs: 60_000,
      pollUrl: 'https://test.example.com/api/vix',
    });

    await feed.start();
    vi.advanceTimersByTime(60_000);
    await flushMicrotasks();

    expect(feed.getLatestVix()).toBeNull();
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    await feed.stop();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 8. Malformed JSON in tick → skip, no crash
// ---------------------------------------------------------------------------

describe('createVixFeed — malformed tick handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips a malformed JSON tick without crashing and leaves VIX null', async () => {
    const redis = makeFakeRedis();
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    // A stream entry with garbage JSON in the data field.
    redis.xread
      .mockResolvedValueOnce(
        makeXreadResult('market.ticks', [{ id: '8-1', data: 'not valid json {{{{' }]),
      )
      .mockResolvedValue(null);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const feed = createVixFeed(redis as unknown as import('ioredis').Redis, {
      clock,
      pollIntervalMs: 10_000_000,
    });

    // Should not throw.
    await feed.start();
    await flushMicrotasks();

    // VIX must remain null — bad tick is silently skipped.
    expect(feed.getLatestVix()).toBeNull();
    // xadd must not have been called.
    expect(redis.xadd).not.toHaveBeenCalled();
    // A warning must have been logged for the parse failure.
    expect(warnSpy).toHaveBeenCalled();

    await feed.stop();
    warnSpy.mockRestore();
  });

  it('skips a tick with missing required fields and leaves VIX null', async () => {
    const redis = makeFakeRedis();
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    // Valid JSON but missing the `ltp` field.
    const incompleteTick = JSON.stringify({ symbol: 'NSE:INDIAVIX-INDEX', timestamp: 123456 });

    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', [{ id: '8-2', data: incompleteTick }]))
      .mockResolvedValue(null);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const feed = createVixFeed(redis as unknown as import('ioredis').Redis, {
      clock,
      pollIntervalMs: 10_000_000,
    });

    await feed.start();
    await flushMicrotasks();

    expect(feed.getLatestVix()).toBeNull();
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    await feed.stop();
    warnSpy.mockRestore();
  });
});
