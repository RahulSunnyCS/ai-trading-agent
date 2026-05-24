/**
 * Unit tests for straddle-calc.ts
 *
 * Tests cover:
 *   1. ATM strike rounding for NIFTY (50pt intervals) and BANKNIFTY (100pt intervals)
 *   2. ROC = 0 when fewer than 2 snapshots in buffer
 *   3. ROC calculation correctness
 *   4. Acceleration = 0 when fewer than 3 snapshots
 *   5. Acceleration = current ROC minus previous ROC
 *   6. Snapshot skipped (no xadd) when CE or PE price is missing
 *   7. Published snapshot has correct straddleValue = cePrice + pePrice
 *
 * Redis is fully mocked — no live Redis connection is required.
 * Timers are faked via vitest so snapshot intervals can be driven deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixedClock } from '../../utils/clock';
import { getAtmStrike } from '../brokers/instrument-registry';
import { computeAcceleration, computeRoc, createStraddleCalculator } from '../straddle-calc';
import type { StraddleSnapshot } from '../straddle-calc';

// ---------------------------------------------------------------------------
// 1. ATM Strike rounding (pure function — no mocking needed)
// ---------------------------------------------------------------------------

describe('getAtmStrike', () => {
  it('rounds NIFTY prices to the nearest 50-point interval', () => {
    // Midpoint rounds up (Math.round semantics)
    expect(getAtmStrike('NIFTY', 22437)).toBe(22450);
    // Below midpoint rounds down
    expect(getAtmStrike('NIFTY', 22424)).toBe(22400);
    // Exact strike is unchanged
    expect(getAtmStrike('NIFTY', 22400)).toBe(22400);
    // At midpoint (22425) rounds up to 22450 per Math.round
    expect(getAtmStrike('NIFTY', 22425)).toBe(22450);
  });

  it('rounds BANKNIFTY prices to the nearest 100-point interval', () => {
    // Midpoint rounds up
    expect(getAtmStrike('BANKNIFTY', 47351)).toBe(47400);
    // Below midpoint rounds down
    expect(getAtmStrike('BANKNIFTY', 47349)).toBe(47300);
    // Exact strike is unchanged
    expect(getAtmStrike('BANKNIFTY', 47400)).toBe(47400);
    // At midpoint (47350) rounds up to 47400 per Math.round
    expect(getAtmStrike('BANKNIFTY', 47350)).toBe(47400);
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. ROC computation (pure function)
// ---------------------------------------------------------------------------

describe('computeRoc', () => {
  it('returns 0 when the buffer is empty', () => {
    expect(computeRoc([])).toBe(0);
  });

  it('returns 0 when the buffer has only 1 entry (need at least 2)', () => {
    expect(computeRoc([100])).toBe(0);
  });

  it('computes ROC correctly: (current - prev) / prev * 100', () => {
    // From 100 to 110: (110 - 100) / 100 * 100 = 10%
    expect(computeRoc([100, 110])).toBeCloseTo(10, 8);
    // From 200 to 190: (190 - 200) / 200 * 100 = -5%
    expect(computeRoc([200, 190])).toBeCloseTo(-5, 8);
    // Only the last two entries matter even if buffer is longer
    expect(computeRoc([50, 60, 100, 110])).toBeCloseTo(10, 8);
  });

  it('returns 0 when the previous value is 0 (avoids divide-by-zero)', () => {
    expect(computeRoc([0, 100])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4 & 5. Acceleration computation (pure function)
// ---------------------------------------------------------------------------

describe('computeAcceleration', () => {
  it('returns 0 when the buffer has fewer than 3 entries', () => {
    expect(computeAcceleration([])).toBe(0);
    expect(computeAcceleration([100])).toBe(0);
    expect(computeAcceleration([100, 110])).toBe(0);
  });

  it('computes acceleration as roc_current - roc_prev', () => {
    // buffer = [a, b, c]
    // roc_prev = (b - a) / a * 100
    // roc_curr = (c - b) / b * 100
    // acceleration = roc_curr - roc_prev
    const a = 100;
    const b = 110;
    const c = 121;
    const rocPrev = ((b - a) / a) * 100; // 10%
    const rocCurr = ((c - b) / b) * 100; // 10%
    const expected = rocCurr - rocPrev; // 0% (constant growth rate)
    expect(computeAcceleration([a, b, c])).toBeCloseTo(expected, 8);
  });

  it('returns positive acceleration when growth rate is increasing', () => {
    // a=100, b=105 (5% ROC), c=115.5 (10% ROC) → acceleration = +5
    const a = 100;
    const b = 105;
    const c = 115.5;
    const rocPrev = ((b - a) / a) * 100; // 5%
    const rocCurr = ((c - b) / b) * 100; // ~10%
    const expected = rocCurr - rocPrev;
    expect(computeAcceleration([a, b, c])).toBeCloseTo(expected, 6);
  });

  it('uses only the last 3 entries from a longer buffer', () => {
    // The first entry (50) should be ignored; only [100, 110, 121] matter
    const a = 100;
    const b = 110;
    const c = 121;
    const rocPrev = ((b - a) / a) * 100;
    const rocCurr = ((c - b) / b) * 100;
    const expected = rocCurr - rocPrev;
    expect(computeAcceleration([50, a, b, c])).toBeCloseTo(expected, 8);
  });

  it('returns 0 when a (3rd-from-last) entry is 0 (divide-by-zero guard)', () => {
    expect(computeAcceleration([0, 100, 110])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Helper: build a minimal fake Redis that records xadd calls
// ---------------------------------------------------------------------------

/**
 * Shapes the XREAD return value the way ioredis actually returns it:
 *   [ [ 'streamName', [ [ 'id', ['field', 'value', ...] ] ] ] ]
 *
 * Returns null (no new messages) when entries is empty.
 *
 * ioredis XREAD return type:
 *   Array<[key: string, items: Array<[id: string, fields: string[]]>]>
 * So the outer array has one element per requested stream, and each element
 * is a 2-tuple of [streamName, messages].
 */
function makeXreadResult(
  streamName: string,
  entries: Array<{ id: string; data: string }>,
): [string, [string, string[]][]][] | null {
  if (entries.length === 0) return null;
  const msgs: [string, string[]][] = entries.map(({ id, data }) => [id, ['data', data]]);
  // One stream entry: [ [streamName, messages] ]
  return [[streamName, msgs]];
}

/** Minimal Redis fake — only the methods touched by straddle-calc are implemented. */
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
// 6. Snapshot skipped when CE or PE price is missing
// ---------------------------------------------------------------------------

describe('createStraddleCalculator — snapshot skipping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call xadd when only the underlying price is known (CE and PE missing)', async () => {
    const redis = makeFakeRedis();

    // A Thursday in IST (2024-01-25 is a Thursday). We pick noon IST (06:30 UTC).
    // This avoids the 15:30 cut-off so getCurrentExpiry returns this Thursday.
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    // Provide only the underlying NIFTY index price — no CE or PE ticks.
    // NIFTY spot at 22400 → ATM = 22400 (exact multiple of 50)
    const underlyingTick = JSON.stringify({
      symbol: 'NSE:NIFTY50-INDEX',
      ltp: 22400,
      timestamp: fixedDate.getTime(),
    });

    // First XREAD call returns the underlying tick; subsequent calls return null.
    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', [{ id: '1-1', data: underlyingTick }]))
      .mockResolvedValue(null);

    // Cast to Redis — the fake implements every method we actually call.
    const calculator = createStraddleCalculator(redis as unknown as import('ioredis').Redis, {
      underlying: 'NIFTY',
      snapshotIntervalMs: 15_000,
      clock,
    });

    await calculator.start();

    // Let the poll loop process the tick (it runs async, one microtask turn).
    // Flush microtasks so the async poll loop can process the XREAD result.
    // We yield several times because each await in the loop is one turn.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Advance fake clock by one interval to fire the setInterval callback.
    vi.advanceTimersByTime(15_000);

    // The snapshot should have been skipped because CE/PE prices are missing.
    expect(redis.xadd).not.toHaveBeenCalled();

    await calculator.stop();
  });
});

// ---------------------------------------------------------------------------
// 7. Published snapshot has correct straddleValue = cePrice + pePrice
// ---------------------------------------------------------------------------

describe('createStraddleCalculator — snapshot publication', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes a snapshot with straddleValue = cePrice + pePrice when all prices are known', async () => {
    const redis = makeFakeRedis();

    // Thursday noon IST — expiry is same-day Thursday (before 15:30 cut-off).
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    // NIFTY spot = 22400 → ATM = 22400
    // Expiry 2024-01-25 → Fyers code: yy=24, month=1, dd=25 → '24125'
    // CE symbol: NSE:NIFTY2412522400CE
    // PE symbol: NSE:NIFTY2412522400PE
    const cePrice = 150;
    const pePrice = 145;

    const ticks = [
      {
        id: '1-1',
        data: JSON.stringify({
          symbol: 'NSE:NIFTY50-INDEX',
          ltp: 22400,
          timestamp: fixedDate.getTime(),
        }),
      },
      {
        id: '1-2',
        data: JSON.stringify({
          symbol: 'NSE:NIFTY2412522400CE',
          ltp: cePrice,
          timestamp: fixedDate.getTime(),
        }),
      },
      {
        id: '1-3',
        data: JSON.stringify({
          symbol: 'NSE:NIFTY2412522400PE',
          ltp: pePrice,
          timestamp: fixedDate.getTime(),
        }),
      },
    ];

    // First XREAD returns all three ticks; subsequent calls return null.
    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', ticks))
      .mockResolvedValue(null);

    const calculator = createStraddleCalculator(redis as unknown as import('ioredis').Redis, {
      underlying: 'NIFTY',
      snapshotIntervalMs: 15_000,
      clock,
    });

    await calculator.start();

    // Process tick data and drive snapshot timer.
    // Flush microtasks so the async poll loop can process the XREAD result.
    // We yield several times because each await in the loop is one turn.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    vi.advanceTimersByTime(15_000);

    // xadd must have been called exactly once.
    expect(redis.xadd).toHaveBeenCalledTimes(1);

    // Extract and parse the published snapshot.
    const xaddArgs: unknown[] = redis.xadd.mock.calls[0] as unknown[];
    // xadd('straddle.values', '*', 'data', <json>)
    expect(xaddArgs[0]).toBe('straddle.values');
    expect(xaddArgs[1]).toBe('*');
    expect(xaddArgs[2]).toBe('data');

    const snapshot = JSON.parse(xaddArgs[3] as string) as StraddleSnapshot;

    expect(snapshot.straddleValue).toBe(cePrice + pePrice);
    expect(snapshot.cePrice).toBe(cePrice);
    expect(snapshot.pePrice).toBe(pePrice);
    expect(snapshot.underlying).toBe('NIFTY');
    expect(snapshot.atmStrike).toBe(22400);
    expect(snapshot.snapshotCount).toBe(1);
    // First snapshot — buffer has only 1 entry, so ROC and acceleration are 0.
    expect(snapshot.roc).toBe(0);
    expect(snapshot.acceleration).toBe(0);

    await calculator.stop();
  });

  it('sets getLatestSnapshot() after a successful snapshot', async () => {
    const redis = makeFakeRedis();

    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    const ticks = [
      {
        id: '2-1',
        data: JSON.stringify({
          symbol: 'NSE:NIFTY50-INDEX',
          ltp: 22400,
          timestamp: fixedDate.getTime(),
        }),
      },
      {
        id: '2-2',
        data: JSON.stringify({
          symbol: 'NSE:NIFTY2412522400CE',
          ltp: 200,
          timestamp: fixedDate.getTime(),
        }),
      },
      {
        id: '2-3',
        data: JSON.stringify({
          symbol: 'NSE:NIFTY2412522400PE',
          ltp: 180,
          timestamp: fixedDate.getTime(),
        }),
      },
    ];

    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', ticks))
      .mockResolvedValue(null);

    const calculator = createStraddleCalculator(redis as unknown as import('ioredis').Redis, {
      underlying: 'NIFTY',
      snapshotIntervalMs: 15_000,
      clock,
    });

    await calculator.start();
    // Flush microtasks so the async poll loop can process the XREAD result.
    // We yield several times because each await in the loop is one turn.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    vi.advanceTimersByTime(15_000);

    const latest = calculator.getLatestSnapshot();
    expect(latest).not.toBeNull();
    expect(latest?.straddleValue).toBe(380); // 200 + 180
    expect(latest?.snapshotCount).toBe(1);

    await calculator.stop();
  });
});
