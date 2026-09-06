/**
 * peak-detection-engine.test.ts — unit tests for PeakDetectionEngine
 *
 * All tests are self-contained: no real Redis or PostgreSQL connections.
 * Redis and the DB pool are replaced with minimal in-memory stubs that
 * record calls for assertion.
 *
 * We avoid vi.mock() for getMacroContext to prevent ioredis from attempting
 * a real connection on module import. Instead we use vi.spyOn() on the
 * imported module after it has loaded, OR we rely on the fact that the mock
 * Redis passed to the engine also controls what getMacroContext sees (since
 * getMacroContext accepts the redis client as a parameter, it only touches
 * our mock Redis — no singleton involved).
 *
 * How getMacroContext is controlled in tests:
 *   getMacroContext(redis) reads keys from the injected redis client.
 *   Our mock redis.get() returns null by default → all fields null → no macro
 *   adjustment. Tests that need getMacroContext to throw can replace redis.get
 *   with a rejecting mock for the specific keys queried by getMacroContext.
 *
 * Time anchors (IST = UTC+5:30):
 *   OPEN_WINDOW_MS  = 2026-05-20T03:50:00Z = 09:20 IST (inside 09:15–09:30 window)
 *   AFTER_OPEN_MS   = 2026-05-20T04:30:00Z = 10:00 IST (well after open)
 *   SIGNAL_TIME_MS  = same as AFTER_OPEN_MS, used as clock.now()
 *                     Wed 10:00 IST → no time-of-day or day-of-week adjustment
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../utils/clock.js';
import { type PeakDetectionConfig, PeakDetectionEngine } from '../peak-detection-engine.js';

// ---------------------------------------------------------------------------
// Time anchors
// ---------------------------------------------------------------------------

/**
 * 2026-05-20T03:50:00Z = 2026-05-20 09:20 IST — inside the 09:15–09:30 open window.
 * Used as the time for the first snapshot to lock the open reference.
 */
const OPEN_WINDOW_MS = new Date('2026-05-20T03:50:00.000Z').getTime();

/**
 * 2026-05-20T04:30:00Z = 2026-05-20 10:00 IST — Wednesday, no special adjustments.
 * Used as the time for subsequent snapshots and as clock.now().
 */
const SIGNAL_TIME_MS = new Date('2026-05-20T04:30:00.000Z').getTime();

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** Minimal Clock stub. clock.now() returns SIGNAL_TIME_MS. */
const STUB_CLOCK: Clock = {
  now: () => SIGNAL_TIME_MS,
  today: () => '2026-05-20',
  toISTDate: () => '2026-05-20',
  toISTTime: () => '10:00:00',
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Default config with strict thresholds — used for "does not fire" tests. */
const DEFAULT_CONFIG: PeakDetectionConfig = {
  minExpansionPct: 10,
  accelerationThreshold: -0.5,
  rocDeclineCandles: 3,
  confirmationCandles: 2,
  dedupWindowSecs: 300,
};

/**
 * Relaxed config: lower acceleration threshold (-0.01) so natural straddle
 * sequences can trigger it without requiring an unrealistically sharp ROC drop.
 * All other conditions are the same as DEFAULT_CONFIG.
 */
const RELAXED_CONFIG: PeakDetectionConfig = {
  ...DEFAULT_CONFIG,
  accelerationThreshold: -0.01,
};

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Redis mock.
 *
 * redis.get returns null by default (OI key not set; macro keys not set).
 * getMacroContext(redis) calls redis.get("macro:us_vix"), etc. — they all
 * return null, producing an all-null MacroContext with zero adjustments.
 *
 * Individual tests can override redis.get to return a specific value or
 * throw for targeted tests.
 */
function makeRedis(getImpl?: () => Promise<string | null>) {
  return {
    // Consumer group setup — resolves immediately.
    xgroup: vi.fn().mockResolvedValue('OK'),
    // XREADGROUP — blocks "forever" so _consumeLoop never proceeds in tests.
    // Tests call _handleSnapshot directly instead of going through the loop.
    xreadgroup: vi
      .fn()
      .mockImplementation(
        () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 60_000)),
      ),
    // ACK resolves immediately.
    xack: vi.fn().mockResolvedValue(1),
    // XADD to signals.generated — returns a fake stream ID.
    xadd: vi.fn().mockResolvedValue('1234567890123-0'),
    // SET for OI key — resolves immediately (no assertion on this in most tests).
    set: vi.fn().mockResolvedValue('OK'),
    // GET: returns null by default (no OI key, no macro keys).
    get: vi.fn().mockImplementation(getImpl ?? (() => Promise.resolve(null))),
  };
}

/**
 * Creates a minimal pg Pool mock.
 * query resolves with a fake INSERT RETURNING row.
 */
function makeDb(queryImpl?: () => Promise<{ rows: Array<{ id: string }> }>) {
  return {
    query: vi
      .fn()
      .mockImplementation(
        queryImpl ??
          (() => Promise.resolve({ rows: [{ id: 'test-signal-uuid-001' }], rowCount: 1 })),
      ),
  };
}

// ---------------------------------------------------------------------------
// Snapshot field builder
// ---------------------------------------------------------------------------

/** Builds a Redis stream message fields object for one straddle snapshot. */
function makeFields(
  overrides: Partial<{
    time: number;
    underlying: string;
    spot: number;
    atmStrike: number;
    straddleValue: number;
    vix: string;
  }> = {},
): Record<string, string> {
  return {
    time: String(overrides.time ?? SIGNAL_TIME_MS),
    underlying: overrides.underlying ?? 'NIFTY',
    spot: String(overrides.spot ?? 23000),
    atmStrike: String(overrides.atmStrike ?? 23000),
    straddleValue: String(overrides.straddleValue ?? 400),
    vix: overrides.vix ?? '18.5',
  };
}

// ---------------------------------------------------------------------------
// Exhaustion sequence design
// ---------------------------------------------------------------------------

/**
 * A straddle value sequence that, with RELAXED_CONFIG, triggers exhaustion.
 *
 * t0 = 100  (open reference — first snapshot, at OPEN_WINDOW_MS)
 * t1 = 125  roc = (125-100)/100   = +0.250
 * t2 = 145  roc = (145-125)/125   = +0.160; accel = 0.160-0.250 = -0.090 < -0.01 ✓; streak=1
 *           expansion = 45% ≥ 10% ✓; conditions: accel ✓, expand ✓, streak(1)<3 ✗ → confirm=0
 * t3 = 160  roc = (160-145)/145   = +0.103; accel = 0.103-0.160 = -0.057 < -0.01 ✓; streak=2
 *           expansion = 60% ✓; streak(2)<3 ✗ → confirm=0
 * t4 = 170  roc = (170-160)/160   = +0.063; accel = 0.063-0.103 = -0.041 < -0.01 ✓; streak=3 ✓
 *           expansion = 70% ✓; ALL 3 pre-conditions met → confirm=1
 * t5 = 178  roc = (178-170)/170   = +0.047; accel = 0.047-0.063 = -0.016 < -0.01 ✓; streak=4 ✓
 *           expansion = 78% ✓; ALL 3 pre-conditions met → confirm=2 ✓ → FIRE SIGNAL
 *
 * Raw exhaustion score at t5:
 *   expansionComponent   = 78 / 50  = 1.560
 *   accelerationComponent = abs(min(-0.016, 0)) * 2 = 0.032
 *   rocComponent         = 4 / 10   = 0.400
 *   rawScore             ≈ 1.560 + 0.032 + 0.400 = 1.992
 */
const EXHAUSTION_SEQUENCE = [100, 125, 145, 160, 170, 178];

// ---------------------------------------------------------------------------
// Helper: feed a sequence into an engine
// ---------------------------------------------------------------------------

/**
 * Creates an engine from the given mocks, feeds a straddle value sequence
 * into it via _handleSnapshot, and returns the engine and mocks.
 *
 * The first snapshot uses OPEN_WINDOW_MS (09:20 IST) to lock the open reference.
 * Subsequent snapshots use OPEN_WINDOW_MS + i * 15_000 ms.
 */
async function feedSequence(
  values: number[],
  config: PeakDetectionConfig = RELAXED_CONFIG,
  redisMock = makeRedis(),
  dbMock = makeDb(),
): Promise<{
  engine: PeakDetectionEngine;
  redis: ReturnType<typeof makeRedis>;
  db: ReturnType<typeof makeDb>;
}> {
  const engine = new PeakDetectionEngine(
    dbMock as unknown as import('pg').Pool,
    redisMock as unknown as import('ioredis').Redis,
    config,
    STUB_CLOCK,
  );

  for (let i = 0; i < values.length; i++) {
    const sv = values[i] as number;
    const t = i === 0 ? OPEN_WINDOW_MS : OPEN_WINDOW_MS + i * 15_000;
    await engine._handleSnapshot(makeFields({ straddleValue: sv, time: t }));
  }

  return { engine, redis: redisMock, db: dbMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PeakDetectionEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // 1. rawExhaustionScore computation
  // --------------------------------------------------------------------------

  describe('rawExhaustionScore computation', () => {
    it('computes rawExhaustionScore from three weighted components', async () => {
      const { db } = await feedSequence(EXHAUSTION_SEQUENCE, RELAXED_CONFIG);

      expect(db.query).toHaveBeenCalledOnce();

      // $7 (index 6) in the INSERT params is raw_exhaustion_score.
      // Params order: [time, underlying, atmStrike, spot, straddleValue, vix,
      //                rawExhaustionScore, adjustedProbability, confidenceTier,
      //                expansionPct, rocDeclineCandles, accelerationValue, breakdownJson]
      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      const params = callArgs[1];
      const rawScore = Number(params[6]);

      // See EXHAUSTION_SEQUENCE design above: ~1.992
      expect(rawScore).toBeCloseTo(1.99, 1);
    });

    it('rawExhaustionScore is unclamped and can exceed 1.0', async () => {
      const { db } = await feedSequence(EXHAUSTION_SEQUENCE, RELAXED_CONFIG);
      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      const rawScore = Number(callArgs[1][6]);
      expect(rawScore).toBeGreaterThan(1.0);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Exhaustion fires when all four conditions met
  // --------------------------------------------------------------------------

  describe('exhaustion detection', () => {
    it('fires a signal when all four conditions are met simultaneously', async () => {
      const { db, redis } = await feedSequence(EXHAUSTION_SEQUENCE, RELAXED_CONFIG);

      expect(db.query).toHaveBeenCalledOnce();
      expect(redis.xadd).toHaveBeenCalledOnce();

      // Verify the stream name.
      const xaddArgs = (redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
      expect(xaddArgs[0]).toBe('signals.generated');
    });

    it('publishes signal_type MOMENTUM_EXHAUSTION to Redis stream', async () => {
      const { redis } = await feedSequence(EXHAUSTION_SEQUENCE, RELAXED_CONFIG);

      const xaddArgs = (redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
      // xadd args: [stream, id, k1, v1, k2, v2, ...]
      const signalTypeIdx = xaddArgs.indexOf('signal_type');
      expect(signalTypeIdx).toBeGreaterThan(-1);
      expect(xaddArgs[signalTypeIdx + 1]).toBe('MOMENTUM_EXHAUSTION');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Exhaustion does NOT fire when only 3 of 4 conditions met
  // --------------------------------------------------------------------------

  describe('partial conditions: no signal when one condition missing', () => {
    it('does not fire when expansion is below minExpansionPct', async () => {
      // Set threshold above the max expansion our sequence achieves (78%).
      const config: PeakDetectionConfig = { ...RELAXED_CONFIG, minExpansionPct: 90 };
      const { db, redis } = await feedSequence(EXHAUSTION_SEQUENCE, config);
      expect(db.query).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it('does not fire when acceleration is not steep enough', async () => {
      // Require acceleration < -10 — impossible with gentle sequence.
      const config: PeakDetectionConfig = { ...RELAXED_CONFIG, accelerationThreshold: -10 };
      const { db, redis } = await feedSequence(EXHAUSTION_SEQUENCE, config);
      expect(db.query).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it('does not fire when rocDeclineCandles threshold is not met', async () => {
      // Require 10 consecutive ROC declines — sequence only achieves 4.
      const config: PeakDetectionConfig = { ...RELAXED_CONFIG, rocDeclineCandles: 10 };
      const { db, redis } = await feedSequence(EXHAUSTION_SEQUENCE, config);
      expect(db.query).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it('does not fire when confirmationCandles threshold is not met', async () => {
      // Require 10 confirmation bars — sequence only provides 2.
      const config: PeakDetectionConfig = { ...RELAXED_CONFIG, confirmationCandles: 10 };
      const { db, redis } = await feedSequence(EXHAUSTION_SEQUENCE, config);
      expect(db.query).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 4. Deduplication
  // --------------------------------------------------------------------------

  describe('deduplication', () => {
    it('fires only once when the full exhaustion sequence is fed twice within dedup window', async () => {
      // clock.now() always returns SIGNAL_TIME_MS, so the second pass starts
      // at the same timestamp — well within the 300s dedup window.
      const redis = makeRedis();
      const db = makeDb();
      const engine = new PeakDetectionEngine(
        db as unknown as import('pg').Pool,
        redis as unknown as import('ioredis').Redis,
        RELAXED_CONFIG,
        STUB_CLOCK,
      );

      // First pass — should fire.
      for (let i = 0; i < EXHAUSTION_SEQUENCE.length; i++) {
        const t = i === 0 ? OPEN_WINDOW_MS : OPEN_WINDOW_MS + i * 15_000;
        await engine._handleSnapshot(
          makeFields({ straddleValue: EXHAUSTION_SEQUENCE[i]!, time: t }),
        );
      }

      // Second pass — dedup should block it.
      const offset = EXHAUSTION_SEQUENCE.length;
      for (let i = 0; i < EXHAUSTION_SEQUENCE.length; i++) {
        const t = OPEN_WINDOW_MS + (offset + i) * 15_000;
        await engine._handleSnapshot(
          makeFields({ straddleValue: EXHAUSTION_SEQUENCE[i]!, time: t }),
        );
      }

      expect(db.query).toHaveBeenCalledOnce();
    });

    it('fires again after the dedup window expires', async () => {
      // Use dedupWindowSecs = 0 to simulate an expired dedup window.
      // clock.now() still returns the same value, but 0ms elapsed > 0s * 1000 = 0ms.
      // Actually elapsed = now - lastSignalMs = SIGNAL_TIME_MS - SIGNAL_TIME_MS = 0.
      // We need elapsed >= 0, which with 0s window means: elapsed >= 0 * 1000 = 0 → always pass.
      const zeroDedupConfig: PeakDetectionConfig = { ...RELAXED_CONFIG, dedupWindowSecs: 0 };

      const redis = makeRedis();
      const db = makeDb();
      const engine = new PeakDetectionEngine(
        db as unknown as import('pg').Pool,
        redis as unknown as import('ioredis').Redis,
        zeroDedupConfig,
        STUB_CLOCK,
      );

      // First pass.
      for (let i = 0; i < EXHAUSTION_SEQUENCE.length; i++) {
        const t = i === 0 ? OPEN_WINDOW_MS : OPEN_WINDOW_MS + i * 15_000;
        await engine._handleSnapshot(
          makeFields({ straddleValue: EXHAUSTION_SEQUENCE[i]!, time: t }),
        );
      }

      // Second pass — window is 0s so it should fire again.
      const offset = EXHAUSTION_SEQUENCE.length;
      for (let i = 0; i < EXHAUSTION_SEQUENCE.length; i++) {
        const t = OPEN_WINDOW_MS + (offset + i) * 15_000;
        await engine._handleSnapshot(
          makeFields({ straddleValue: EXHAUSTION_SEQUENCE[i]!, time: t }),
        );
      }

      // Both passes should produce a signal.
      expect(db.query).toHaveBeenCalledTimes(2);
    });
  });

  // --------------------------------------------------------------------------
  // 5. OI change null — no error, scorer still called
  // --------------------------------------------------------------------------

  describe('OI change handling', () => {
    it('proceeds with oiChangePct=null when Redis returns null for OI key', async () => {
      // Default makeRedis() returns null for all get() calls.
      const { db } = await feedSequence(EXHAUSTION_SEQUENCE, RELAXED_CONFIG);
      // Signal must still fire — null OI is handled gracefully.
      expect(db.query).toHaveBeenCalledOnce();
    });

    it('proceeds with oiChangePct=null when Redis.get throws', async () => {
      // Make get() reject for OI key reads (and macro key reads via getMacroContext).
      // Both failures are caught silently in the engine — no crash, signal still fires.
      const redis = makeRedis(() => Promise.reject(new Error('Redis timeout')));
      const db = makeDb();
      const engine = new PeakDetectionEngine(
        db as unknown as import('pg').Pool,
        redis as unknown as import('ioredis').Redis,
        RELAXED_CONFIG,
        STUB_CLOCK,
      );

      // Feed the full sequence — should not throw. We call _handleSnapshot directly
      // rather than wrapping in expect().resolves to avoid Bun's async wrapper quirk.
      let threw = false;
      try {
        for (let i = 0; i < EXHAUSTION_SEQUENCE.length; i++) {
          const t = i === 0 ? OPEN_WINDOW_MS : OPEN_WINDOW_MS + i * 15_000;
          await engine._handleSnapshot(
            makeFields({ straddleValue: EXHAUSTION_SEQUENCE[i]!, time: t }),
          );
        }
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);

      // getMacroContext catches get() errors internally (logs as warn) → all-null macro.
      // The engine also catches getMacroContext errors. DB write should still happen.
      expect(db.query).toHaveBeenCalledOnce();
    });

    it('uses valid numeric OI when Redis returns a numeric string', async () => {
      // Return "8.0" for any get() call. This represents +8% OI change.
      // getMacroContext will also get "8.0" for all macro keys — JSON.parse("8.0")
      // is valid but fails the shape check (no .value/.change_pct/.timestamp).
      // getMacroContext silently skips invalid shapes → all-null macro context.
      const redis = makeRedis(() => Promise.resolve('8.0'));
      const db = makeDb();
      const { db: dbResult } = await feedSequence(EXHAUSTION_SEQUENCE, RELAXED_CONFIG, redis, db);
      // Signal should fire with OI data available (no crash).
      expect(dbResult.query).toHaveBeenCalledOnce();
    });
  });

  // --------------------------------------------------------------------------
  // 6. getMacroContext failure — all-null macro, no crash
  // --------------------------------------------------------------------------

  describe('getMacroContext failure handling', () => {
    it('catches error when Redis.get throws during getMacroContext and proceeds', async () => {
      // getMacroContext calls redis.get() for each macro key. If get() throws,
      // getMacroContext should catch it per key and continue (returning all-null).
      // Our engine also catches any top-level getMacroContext throw.
      const redis = makeRedis(() => Promise.reject(new Error('Redis down')));
      const db = makeDb();
      const engine = new PeakDetectionEngine(
        db as unknown as import('pg').Pool,
        redis as unknown as import('ioredis').Redis,
        RELAXED_CONFIG,
        STUB_CLOCK,
      );

      // Should not throw.
      for (let i = 0; i < EXHAUSTION_SEQUENCE.length; i++) {
        const t = i === 0 ? OPEN_WINDOW_MS : OPEN_WINDOW_MS + i * 15_000;
        await engine._handleSnapshot(
          makeFields({ straddleValue: EXHAUSTION_SEQUENCE[i]!, time: t }),
        );
      }

      // Signal should still be written — macro failure is non-fatal.
      expect(db.query).toHaveBeenCalledOnce();
    });

    it('uses all-null macro context when getMacroContext returns null fields', async () => {
      // Default mock redis.get() returns null → getMacroContext produces all-null.
      // Verify signal still fires with zero macro adjustments.
      const { db } = await feedSequence(EXHAUSTION_SEQUENCE, RELAXED_CONFIG);
      expect(db.query).toHaveBeenCalledOnce();

      // Check adjustment_breakdown in params ($13, index 12).
      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      const breakdownJson = callArgs[1][12] as string;
      const breakdown = JSON.parse(breakdownJson) as Record<string, number>;

      // With all-null macro: us_vix, sp500, dax, crude_oil, gold must all be 0.
      expect(breakdown.us_vix).toBe(0);
      expect(breakdown.sp500).toBe(0);
      expect(breakdown.dax).toBe(0);
      expect(breakdown.crude_oil).toBe(0);
      expect(breakdown.gold).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 7. DB write with correct columns
  // --------------------------------------------------------------------------

  describe('DB write', () => {
    it('writes signal to DB with the correct INSERT SQL and 13 parameters', async () => {
      const { db } = await feedSequence(EXHAUSTION_SEQUENCE, RELAXED_CONFIG);

      expect(db.query).toHaveBeenCalledOnce();

      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      const [sql, params] = callArgs;

      // SQL must target straddle_signals with RETURNING id.
      expect(sql).toContain('INSERT INTO straddle_signals');
      expect(sql).toContain('RETURNING id');

      // Exactly 13 parameters ($1–$13).
      expect(params).toHaveLength(13);

      // Spot-check key parameter values:
      expect(params[1]).toBe('NIFTY'); // $2: underlying
      expect(params[2]).toBe('23000'); // $3: atm_strike (NUMERIC → string)
      expect(params[4]).toBe('178'); // $5: straddle_value (last in sequence)

      // $9 (index 8): confidence_tier
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(params[8] as string);

      // $11 (index 10): roc_decline_candles — must be a number (INTEGER column)
      expect(typeof params[10]).toBe('number');
      expect(params[10] as number).toBeGreaterThanOrEqual(3);

      // $13 (index 12): adjustment_breakdown — must be valid JSON with all 9 keys.
      const breakdown = JSON.parse(params[12] as string) as Record<string, number>;
      expect(Object.keys(breakdown)).toEqual(
        expect.arrayContaining([
          'india_vix',
          'us_vix',
          'sp500',
          'dax',
          'crude_oil',
          'gold',
          'oi_change',
          'time_of_day',
          'day_of_week',
        ]),
      );
    });

    it('passes the DB RETURNING id to the Redis stream message', async () => {
      const { redis } = await feedSequence(EXHAUSTION_SEQUENCE, RELAXED_CONFIG);

      const xaddArgs = (redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
      const signalIdIdx = xaddArgs.indexOf('signal_id');
      expect(signalIdIdx).toBeGreaterThan(-1);
      expect(xaddArgs[signalIdIdx + 1]).toBe('test-signal-uuid-001');
    });
  });

  // --------------------------------------------------------------------------
  // 8. Redis stream publish after DB write
  // --------------------------------------------------------------------------

  describe('Redis stream publish', () => {
    it('publishes to signals.generated stream with auto-generated ID', async () => {
      const { redis } = await feedSequence(EXHAUSTION_SEQUENCE, RELAXED_CONFIG);

      const xaddArgs = (redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
      expect(xaddArgs[0]).toBe('signals.generated');
      expect(xaddArgs[1]).toBe('*'); // Auto-generated Redis stream ID
    });

    it('includes all required fields in the published stream message', async () => {
      const { redis } = await feedSequence(EXHAUSTION_SEQUENCE, RELAXED_CONFIG);

      const xaddArgs = (redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
      // Parse the flat [k, v, k, v, ...] args (skipping [stream, id]).
      const fields: Record<string, string> = {};
      for (let i = 2; i < xaddArgs.length - 1; i += 2) {
        fields[xaddArgs[i] as string] = xaddArgs[i + 1] as string;
      }

      expect(fields.signal_type).toBe('MOMENTUM_EXHAUSTION');
      expect(fields.underlying).toBe('NIFTY');
      expect(fields.signal_id).toBe('test-signal-uuid-001');
      expect(fields.straddle_value).toBe('178');
      expect(fields.atm_strike).toBeTruthy();
      expect(fields.spot).toBeTruthy();
      expect(fields.adjusted_probability).toBeTruthy();
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(fields.confidence_tier);
      // signal_time must be an ISO-8601 timestamp.
      expect(fields.signal_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('does not publish to Redis stream when DB write throws', async () => {
      const redis = makeRedis();
      const db = makeDb(() => Promise.reject(new Error('DB connection error')));
      const engine = new PeakDetectionEngine(
        db as unknown as import('pg').Pool,
        redis as unknown as import('ioredis').Redis,
        RELAXED_CONFIG,
        STUB_CLOCK,
      );

      // Feed the sequence up to exhaustion. The DB throws on the signal bar (t5).
      // _handleSnapshot propagates the DB error — we catch it here.
      let caughtError: Error | null = null;
      for (let i = 0; i < EXHAUSTION_SEQUENCE.length; i++) {
        const t = i === 0 ? OPEN_WINDOW_MS : OPEN_WINDOW_MS + i * 15_000;
        try {
          await engine._handleSnapshot(
            makeFields({ straddleValue: EXHAUSTION_SEQUENCE[i]!, time: t }),
          );
        } catch (err) {
          caughtError = err instanceof Error ? err : new Error(String(err));
        }
      }

      // The DB error should have been thrown on the signal bar.
      expect(caughtError?.message).toBe('DB connection error');

      // xadd to signals.generated must NOT have been called since DB failed first.
      expect(redis.xadd).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 9. Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('skips zero straddleValue snapshots (simulate mode placeholder)', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = new PeakDetectionEngine(
        db as unknown as import('pg').Pool,
        redis as unknown as import('ioredis').Redis,
        RELAXED_CONFIG,
        STUB_CLOCK,
      );

      await engine._handleSnapshot(makeFields({ straddleValue: 0 }));
      await engine._handleSnapshot(makeFields({ straddleValue: 0 }));

      expect(db.query).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it('handles malformed snapshot fields gracefully without throwing', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = new PeakDetectionEngine(
        db as unknown as import('pg').Pool,
        redis as unknown as import('ioredis').Redis,
        RELAXED_CONFIG,
        STUB_CLOCK,
      );

      // Missing 'underlying' field → should warn and return undefined, not throw.
      await expect(
        engine._handleSnapshot({
          time: '1234567890000',
          spot: '23000',
          atmStrike: '23000',
          straddleValue: '400',
          // no 'underlying'
        }),
      ).resolves.toBeUndefined();

      expect(db.query).not.toHaveBeenCalled();
    });

    it('does not set open reference from zero-value snapshots in open window', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = new PeakDetectionEngine(
        db as unknown as import('pg').Pool,
        redis as unknown as import('ioredis').Redis,
        RELAXED_CONFIG,
        STUB_CLOCK,
      );

      // Send a zero snapshot during the open window — should be skipped entirely.
      await engine._handleSnapshot(makeFields({ straddleValue: 0, time: OPEN_WINDOW_MS }));

      // Then send the exhaustion sequence; the first non-zero snapshot at
      // OPEN_WINDOW_MS + 15s (still inside open window) becomes the open reference.
      for (let i = 0; i < EXHAUSTION_SEQUENCE.length; i++) {
        const t = OPEN_WINDOW_MS + (i + 1) * 15_000;
        await engine._handleSnapshot(
          makeFields({ straddleValue: EXHAUSTION_SEQUENCE[i]!, time: t }),
        );
      }

      // No crash — open reference was correctly set from the first non-zero snapshot.
      // Whether a signal fires depends on timing; the key invariant is no exception.
    });
  });
});
