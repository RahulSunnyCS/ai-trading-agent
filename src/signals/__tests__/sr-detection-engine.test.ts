/**
 * sr-detection-engine.test.ts — unit tests for SRDetectionEngine
 *
 * All tests are self-contained: no real Redis or PostgreSQL connections.
 * Redis, DB pool, and the sr-levels module are replaced with minimal stubs
 * that record calls for assertion.
 *
 * The sr-levels module (computeSRLevels, assertHistoryCoverage) is mocked via
 * vi.mock() at the top of the file. This prevents any real DB calls and lets
 * tests control exactly which levels are returned or which errors are thrown.
 *
 * Test coverage:
 *   1. Proximity trigger — signal fires when spot is within proximityPoints.
 *   2. Proximity miss — no signal when spot is outside proximityPoints.
 *   3. Strength floor — no signal when level strength is below the floor.
 *   4. poc_used tagging — DB write carries the correct poc_used boolean.
 *   5. level_source tagging — DB write includes a valid level_source JSON blob.
 *   6. VIX-null path — signal fires correctly with vix=null (no crash, no divide).
 *   7. ACTIVE_PHASE gate — no signal when ACTIVE_PHASE is unset or < 2.
 *   8. ACTIVE_PHASE=2 — signal fires when ACTIVE_PHASE is exactly 2.
 *   9. Freshness-disable path — coverage error disables that underlying only,
 *      NOT other underlyings.
 *  10. Dedup window — same level does not fire twice within dedupWindowSecs.
 *  11. Dedup reset — different level buckets do not share the dedup entry.
 *  12. Multiple levels — only qualifying levels emit signals per snapshot.
 *  13. Malformed snapshot — no crash, no signal.
 *
 * Time anchors (IST = UTC+5:30):
 *   SIGNAL_TIME_MS = 2026-05-20T04:30:00Z = 2026-05-20 10:00 IST (Wednesday)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../utils/clock.js';
import { type SRDetectionConfig, SRDetectionEngine } from '../sr-detection-engine.js';

// ---------------------------------------------------------------------------
// vi.mock must appear at module top-level (Vitest hoists it).
// We mock the sr-levels module so no real DB queries are needed.
// The module path must match the import in sr-detection-engine.ts exactly.
//
// IMPORTANT: vi.clearAllMocks() in beforeEach clears mock call history but
// also resets mockReturnValue/mockResolvedValue implementations. We therefore
// re-establish all default return values inside beforeEach, not here.
// The vi.fn() calls here just set up the mock shape; beforeEach populates defaults.
// ---------------------------------------------------------------------------
vi.mock('../sr-levels.js', () => ({
  // computeSRLevels: replaced per-test via mockResolvedValue in beforeEach.
  computeSRLevels: vi.fn(),
  // assertHistoryCoverage: default = resolves (coverage OK) set in beforeEach.
  assertHistoryCoverage: vi.fn(),
  // InsufficientHistoryCoverageError: keep the real class so instanceof checks work.
  InsufficientHistoryCoverageError: class InsufficientHistoryCoverageError extends Error {
    readonly underlying: string;
    readonly actualBars: number;
    readonly expectedBars: number;
    constructor(underlying: string, actualBars: number, expectedBars: number) {
      super(
        `[sr-levels] Insufficient history for ${underlying}: ` +
          `got ${actualBars} bars, need >= ${expectedBars}. ` +
          `S/R disabled for this index today.`,
      );
      this.name = 'InsufficientHistoryCoverageError';
      this.underlying = underlying;
      this.actualBars = actualBars;
      this.expectedBars = expectedBars;
    }
  },
  // prevIstWeekWindow and istDateToUtcMs: used in _loadLevels; defaults set in beforeEach.
  prevIstWeekWindow: vi.fn(),
  istDateToUtcMs: vi.fn(),
}));

// Import mocked functions AFTER vi.mock() declaration.
// These references point to the mocked versions — the same vi.fn() objects
// created by vi.mock() above. We use them both for mockImplementation() calls
// and for the prevIstWeekWindow/istDateToUtcMs restores in beforeEach.
import {
  computeSRLevels,
  assertHistoryCoverage,
  InsufficientHistoryCoverageError,
  prevIstWeekWindow,
  istDateToUtcMs,
} from '../sr-levels.js';

// ---------------------------------------------------------------------------
// Time anchors
// ---------------------------------------------------------------------------

/** 2026-05-20T04:30:00Z = 2026-05-20 10:00 IST — Wednesday, in session. */
const SIGNAL_TIME_MS = new Date('2026-05-20T04:30:00.000Z').getTime();

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** Fixed Clock stub — always returns SIGNAL_TIME_MS and '2026-05-20'. */
const STUB_CLOCK: Clock = {
  now: () => SIGNAL_TIME_MS,
  today: () => '2026-05-20',
  toISTDate: () => '2026-05-20',
  toISTTime: () => '10:00:00',
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Default test config with tighter thresholds for predictable test control.
 * proximityPoints=50, strengthFloor=0.20, dedupWindowSecs=300.
 */
const DEFAULT_CONFIG: SRDetectionConfig = {
  proximityPoints: 50,
  strengthFloor: 0.2,
  dedupWindowSecs: 300,
  minHistoryBars: 100,
  levelBucketPts: 50,
};

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Minimal Redis mock. Mirrors the pattern from peak-detection-engine.test.ts:
 * - xgroup: resolves OK (consumer group creation).
 * - xreadgroup: blocks forever — tests call _handleSnapshot directly.
 * - xack: resolves immediately.
 * - xadd: returns a fake stream ID.
 */
function makeRedis() {
  return {
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi
      .fn()
      .mockImplementation(
        () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 60_000)),
      ),
    xack: vi.fn().mockResolvedValue(1),
    xadd: vi.fn().mockResolvedValue('1234567890123-0'),
    get: vi.fn().mockResolvedValue(null),
  };
}

/**
 * Minimal pg Pool mock.
 * query resolves with a fake INSERT RETURNING row containing a UUID.
 */
function makeDb(queryImpl?: () => Promise<{ rows: Array<{ id: string }> }>) {
  return {
    query: vi
      .fn()
      .mockImplementation(
        queryImpl ??
          (() => Promise.resolve({ rows: [{ id: 'test-sr-signal-uuid-001' }], rowCount: 1 })),
      ),
  };
}

// ---------------------------------------------------------------------------
// Level builders
// ---------------------------------------------------------------------------

/**
 * Builds a single SRLevel object for test setup.
 * Defaults: price=22500, type='pivot', strength=0.6, poc_used=false.
 */
function makeLevel(overrides?: {
  price?: number;
  type?: 'prev_week_high' | 'prev_week_low' | 'pivot' | 'poc';
  strength?: number;
  poc_used?: boolean;
}) {
  return {
    price: overrides?.price ?? 22500,
    type: overrides?.type ?? 'pivot',
    strength: overrides?.strength ?? 0.6,
    poc_used: overrides?.poc_used ?? false,
  };
}

/**
 * Builds a minimal SRLevelResult for use with computeSRLevels mock.
 */
function makeLevelResult(levels: ReturnType<typeof makeLevel>[]) {
  const poc_used = levels.some((l) => l.poc_used);
  return {
    levels,
    contributed: ['pivot' as const],
    poc_used,
  };
}

// ---------------------------------------------------------------------------
// Snapshot field builder
// ---------------------------------------------------------------------------

/**
 * Builds a Redis stream message fields object for one straddle snapshot.
 * Mirrors the makeFields helper from peak-detection-engine.test.ts.
 */
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
    spot: String(overrides.spot ?? 22500),
    atmStrike: String(overrides.atmStrike ?? 22500),
    straddleValue: String(overrides.straddleValue ?? 400),
    vix: overrides.vix ?? '15.0',
  };
}

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

/**
 * Creates an SRDetectionEngine with the given mocks and config.
 * Sets ACTIVE_PHASE=2 in process.env for tests that expect signals to fire.
 * Callers that need a different phase can set process.env.ACTIVE_PHASE explicitly.
 */
function makeEngine(
  redisMock = makeRedis(),
  dbMock = makeDb(),
  config: SRDetectionConfig = DEFAULT_CONFIG,
): SRDetectionEngine {
  return new SRDetectionEngine(
    dbMock as unknown as import('pg').Pool,
    redisMock as unknown as import('ioredis').Redis,
    config,
    STUB_CLOCK,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SRDetectionEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: ACTIVE_PHASE=2 so most tests can focus on signal logic.
    process.env.ACTIVE_PHASE = '2';
    // Re-establish default mock return values after vi.clearAllMocks() wipes them.
    // vi.clearAllMocks() resets call counts AND mockReturnValue/mockResolvedValue
    // implementations set before the suite, so we restore them here.

    // assertHistoryCoverage: resolves (coverage OK) — most tests assume data is present.
    vi.mocked(assertHistoryCoverage).mockResolvedValue(undefined);
    // computeSRLevels: returns a single strong pivot level at 22500 by default.
    vi.mocked(computeSRLevels).mockResolvedValue(
      makeLevelResult([makeLevel({ price: 22500, strength: 0.6, poc_used: false })]),
    );
    // prevIstWeekWindow and istDateToUtcMs: used in _loadLevels.
    // The imported prevIstWeekWindow/istDateToUtcMs ARE the vi.fn() mock objects
    // from vi.mock() — restoring them here is safe because they share identity.
    vi.mocked(prevIstWeekWindow).mockReturnValue({ from: 0, to: 1_000_000 });
    vi.mocked(istDateToUtcMs).mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ACTIVE_PHASE;
  });

  // --------------------------------------------------------------------------
  // 1. Proximity trigger
  // --------------------------------------------------------------------------

  describe('proximity trigger', () => {
    it('emits a signal when spot is exactly at a qualified level', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      // spot == level.price (22500) → distance = 0 ≤ 50 ✓
      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      expect(db.query).toHaveBeenCalledOnce();
      expect(redis.xadd).toHaveBeenCalledOnce();
    });

    it('emits a signal when spot is within proximityPoints of a level', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      // spot = 22540, level = 22500: distance = 40 ≤ 50 ✓
      await engine._handleSnapshot(makeFields({ spot: 22540 }));

      expect(db.query).toHaveBeenCalledOnce();
      expect(redis.xadd).toHaveBeenCalledOnce();
    });

    it('emits a signal when spot is exactly at the proximity boundary', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      // spot = 22450, level = 22500: distance = 50 = 50 ✓ (boundary is inclusive)
      await engine._handleSnapshot(makeFields({ spot: 22450 }));

      expect(db.query).toHaveBeenCalledOnce();
    });

    it('does NOT emit when spot is beyond proximityPoints from all levels', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      // spot = 22449, level = 22500: distance = 51 > 50 ✗
      await engine._handleSnapshot(makeFields({ spot: 22449 }));

      expect(db.query).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 2. Strength floor
  // --------------------------------------------------------------------------

  describe('strength floor', () => {
    it('does NOT emit when level strength is below the floor', async () => {
      // Level strength = 0.15, floor = 0.20 → does not qualify.
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([makeLevel({ price: 22500, strength: 0.15 })]),
      );

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      expect(db.query).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it('emits when level strength is exactly at the floor', async () => {
      // Level strength = 0.20, floor = 0.20 → qualifies (>= comparison).
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([makeLevel({ price: 22500, strength: 0.2 })]),
      );

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      expect(db.query).toHaveBeenCalledOnce();
    });

    it('does NOT emit when all levels are below the strength floor', async () => {
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([
          makeLevel({ price: 22500, strength: 0.1 }),
          makeLevel({ price: 22000, strength: 0.05 }),
        ]),
      );

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      // spot near both levels but both below floor
      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      expect(db.query).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 3. poc_used tagging
  // --------------------------------------------------------------------------

  describe('poc_used tagging', () => {
    it('writes poc_used=true when the triggered level is a POC level', async () => {
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([makeLevel({ price: 22500, strength: 0.7, poc_used: true })]),
      );

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      expect(db.query).toHaveBeenCalledOnce();
      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      const params = callArgs[1];
      // $17 (index 16): poc_used
      expect(params[16]).toBe(true);
    });

    it('writes poc_used=false when the triggered level is not a POC level', async () => {
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([makeLevel({ price: 22500, strength: 0.7, poc_used: false })]),
      );

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      const params = callArgs[1];
      expect(params[16]).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 4. level_source tagging
  // --------------------------------------------------------------------------

  describe('level_source tagging', () => {
    it('writes a valid JSON blob to level_source with triggered_level and levels array', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      const params = callArgs[1];
      // $18 (index 17): level_source (JSONB serialised as JSON string)
      const levelSourceJson = params[17] as string;
      const levelSource = JSON.parse(levelSourceJson) as {
        levels: Array<{ price: number; type: string; strength: number; poc_used: boolean }>;
        triggered_level: { price: number; type: string; strength: number };
      };

      expect(levelSource).toHaveProperty('levels');
      expect(levelSource).toHaveProperty('triggered_level');
      expect(Array.isArray(levelSource.levels)).toBe(true);
      expect(levelSource.triggered_level.price).toBe(22500);
      expect(typeof levelSource.triggered_level.strength).toBe('number');
    });

    it('includes the triggered level in level_source', async () => {
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([
          makeLevel({ price: 22500, type: 'poc', strength: 0.8, poc_used: true }),
        ]),
      );

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      const params = callArgs[1];
      const levelSource = JSON.parse(params[17] as string) as {
        triggered_level: { price: number; type: string };
      };

      expect(levelSource.triggered_level.price).toBe(22500);
      expect(levelSource.triggered_level.type).toBe('poc');
    });

    it('writes sr_subtype=SR_REVERSAL in the DB params', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      const params = callArgs[1];
      // $15 (index 14): sr_subtype
      expect(params[14]).toBe('SR_REVERSAL');
    });
  });

  // --------------------------------------------------------------------------
  // 5. VIX-null path
  // --------------------------------------------------------------------------

  describe('VIX-null path', () => {
    it('emits signal correctly when vix field is "null" string', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500, vix: 'null' }));

      // Signal must fire — null VIX is handled gracefully.
      expect(db.query).toHaveBeenCalledOnce();
      expect(redis.xadd).toHaveBeenCalledOnce();

      // Verify vix param is null in DB write.
      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      const params = callArgs[1];
      // $7 (index 6): vix — must be null when input was "null"
      expect(params[6]).toBeNull();
    });

    it('emits signal correctly when vix field is missing', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      const fieldsNoVix: Record<string, string> = {
        time: String(SIGNAL_TIME_MS),
        underlying: 'NIFTY',
        spot: '22500',
        atmStrike: '22500',
        straddleValue: '400',
        // no vix field
      };

      await engine._handleSnapshot(fieldsNoVix);

      expect(db.query).toHaveBeenCalledOnce();
      // vix param should be null
      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(callArgs[1][6]).toBeNull();
    });

    it('does not divide by or assume a VIX value (structural check)', async () => {
      // This test verifies the VIX value is stored but not used in arithmetic.
      // We pass an extreme VIX value and confirm signal emission is unchanged.
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      // VIX = 0 would cause division-by-zero if the engine divided by it.
      await engine._handleSnapshot(makeFields({ spot: 22500, vix: '0' }));

      // Signal should still fire — VIX=0 should not crash or suppress.
      expect(db.query).toHaveBeenCalledOnce();
      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      // VIX param is stored as-is ('0'), not computed against.
      expect(callArgs[1][6]).toBe('0');
    });
  });

  // --------------------------------------------------------------------------
  // 6. ACTIVE_PHASE gate
  // --------------------------------------------------------------------------

  describe('ACTIVE_PHASE gate', () => {
    it('does NOT emit when ACTIVE_PHASE is not set (defaults to 1)', async () => {
      delete process.env.ACTIVE_PHASE; // Unset → defaults to 1

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      expect(db.query).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it('does NOT emit when ACTIVE_PHASE=1', async () => {
      process.env.ACTIVE_PHASE = '1';

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      expect(db.query).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it('emits when ACTIVE_PHASE=2', async () => {
      process.env.ACTIVE_PHASE = '2';

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      expect(db.query).toHaveBeenCalledOnce();
    });

    it('emits when ACTIVE_PHASE=3 (future phase)', async () => {
      process.env.ACTIVE_PHASE = '3';

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      expect(db.query).toHaveBeenCalledOnce();
    });

    it('does NOT emit when ACTIVE_PHASE is non-numeric (treated as NaN < 2)', async () => {
      process.env.ACTIVE_PHASE = 'invalid';

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      expect(db.query).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 7. Freshness-disable path
  // --------------------------------------------------------------------------

  describe('freshness-disable path', () => {
    it('disables S/R for an underlying when assertHistoryCoverage throws InsufficientHistoryCoverageError', async () => {
      // Make assertHistoryCoverage throw for NIFTY.
      vi.mocked(assertHistoryCoverage).mockRejectedValue(
        new InsufficientHistoryCoverageError('NIFTY', 50, 500),
      );

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      // First snapshot triggers level load → coverage fails → disabled.
      await engine._handleSnapshot(makeFields({ spot: 22500, underlying: 'NIFTY' }));

      expect(db.query).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();

      // Second snapshot — still disabled, computeSRLevels not called again.
      await engine._handleSnapshot(makeFields({ spot: 22500, underlying: 'NIFTY' }));

      // computeSRLevels should never have been called (assertHistoryCoverage threw first).
      expect(computeSRLevels).not.toHaveBeenCalled();
      expect(db.query).not.toHaveBeenCalled();
    });

    it('disables ONLY the failing underlying — other underlyings still receive signals', async () => {
      // NIFTY fails coverage; BANKNIFTY is fine.
      vi.mocked(assertHistoryCoverage).mockImplementation(
        async (pool, underlying) => {
          if (underlying === 'NIFTY') {
            throw new InsufficientHistoryCoverageError('NIFTY', 50, 500);
          }
          // BANKNIFTY passes silently.
        },
      );

      // computeSRLevels only called for BANKNIFTY — return a proximate level.
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([makeLevel({ price: 47000, strength: 0.7, poc_used: false })]),
      );

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      // Feed NIFTY — should be disabled, no signal.
      await engine._handleSnapshot(makeFields({ spot: 22500, underlying: 'NIFTY' }));

      expect(db.query).not.toHaveBeenCalled();

      // Feed BANKNIFTY — should still work.
      await engine._handleSnapshot(
        makeFields({ spot: 47000, atmStrike: 47000, underlying: 'BANKNIFTY' }),
      );

      // BANKNIFTY signal should fire.
      expect(db.query).toHaveBeenCalledOnce();
      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(callArgs[1][1]).toBe('BANKNIFTY'); // $2: underlying
    });

    it('does not crash the process on InsufficientHistoryCoverageError', async () => {
      vi.mocked(assertHistoryCoverage).mockRejectedValue(
        new InsufficientHistoryCoverageError('NIFTY', 10, 500),
      );

      const engine = makeEngine();

      let threw = false;
      try {
        await engine._handleSnapshot(makeFields({ spot: 22500 }));
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 8. Dedup window
  // --------------------------------------------------------------------------

  describe('dedup window', () => {
    it('does NOT emit a second signal for the same level within dedupWindowSecs', async () => {
      // STUB_CLOCK.now() always returns SIGNAL_TIME_MS → same timestamp both calls.
      // With dedupWindowSecs=300, elapsed=0 < 300000ms → deduped.
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      // First snapshot — should fire.
      await engine._handleSnapshot(makeFields({ spot: 22500 }));
      expect(db.query).toHaveBeenCalledOnce();

      // Second snapshot at same time — dedup blocks it.
      await engine._handleSnapshot(makeFields({ spot: 22500 }));
      expect(db.query).toHaveBeenCalledOnce(); // still 1, not 2
    });

    it('emits again after the dedup window expires (dedupWindowSecs=0)', async () => {
      // With dedupWindowSecs=0, elapsed >= 0ms is always satisfied → re-fires.
      const zeroDedup: SRDetectionConfig = { ...DEFAULT_CONFIG, dedupWindowSecs: 0 };

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db, zeroDedup);

      // First snapshot.
      await engine._handleSnapshot(makeFields({ spot: 22500 }));
      // Second snapshot — dedup window is 0 so it fires again.
      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      expect(db.query).toHaveBeenCalledTimes(2);
    });

    it('dedup is per-level-bucket — different levels do not share dedup', async () => {
      // Two levels: 22500 and 22000 (different buckets with levelBucketPts=50).
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([
          makeLevel({ price: 22500, strength: 0.7 }),
          makeLevel({ price: 22000, strength: 0.6 }),
        ]),
      );

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      // First snapshot at 22500 — triggers level 22500 only (22000 is 500 pts away).
      await engine._handleSnapshot(makeFields({ spot: 22500 }));
      expect(db.query).toHaveBeenCalledTimes(1);

      // Second snapshot at 22000 — triggers level 22000 only (22500 is now 500 pts away).
      await engine._handleSnapshot(makeFields({ spot: 22000, atmStrike: 22000 }));
      // Level 22000 has its own dedup entry, not shared with 22500.
      expect(db.query).toHaveBeenCalledTimes(2);
    });
  });

  // --------------------------------------------------------------------------
  // 9. DB write column validation
  // --------------------------------------------------------------------------

  describe('DB write column validation', () => {
    it('writes INSERT with correct signal_type PULLBACK in SQL params', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      const [sql, params] = callArgs;

      expect(sql).toContain('INSERT INTO straddle_signals');
      expect(sql).toContain('RETURNING id');

      // $3 (index 2): signal_type
      expect(params[2]).toBe('PULLBACK');
    });

    it('passes the DB RETURNING id to the Redis stream message', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      const xaddArgs = (redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
      const signalIdIdx = xaddArgs.indexOf('signal_id');
      expect(signalIdIdx).toBeGreaterThan(-1);
      expect(xaddArgs[signalIdIdx + 1]).toBe('test-sr-signal-uuid-001');
    });

    it('publishes to signals.generated with auto-generated ID', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      const xaddArgs = (redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
      expect(xaddArgs[0]).toBe('signals.generated');
      expect(xaddArgs[1]).toBe('*');
    });

    it('includes sr_subtype in the Redis stream message', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      const xaddArgs = (redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
      const fields: Record<string, string> = {};
      for (let i = 2; i < xaddArgs.length - 1; i += 2) {
        fields[xaddArgs[i] as string] = xaddArgs[i + 1] as string;
      }

      expect(fields.sr_subtype).toBe('SR_REVERSAL');
      expect(fields.signal_type).toBe('PULLBACK');
      expect(fields.underlying).toBe('NIFTY');
    });

    it('does not publish to Redis stream when DB write throws', async () => {
      const redis = makeRedis();
      const db = makeDb(() => Promise.reject(new Error('DB connection error')));
      const engine = makeEngine(redis, db);

      let threw = false;
      try {
        await engine._handleSnapshot(makeFields({ spot: 22500 }));
      } catch {
        threw = true;
      }

      // DB error should propagate (not swallowed here — consumer loop handles it).
      expect(threw).toBe(true);
      // xadd must NOT have been called.
      expect(redis.xadd).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 10. Multiple levels in one snapshot
  // --------------------------------------------------------------------------

  describe('multiple levels', () => {
    it('emits one signal per qualifying level per snapshot (when dedup allows)', async () => {
      // Two levels, both near spot 22500 with dedupWindowSecs=0 so both fire.
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([
          makeLevel({ price: 22480, strength: 0.7 }),
          makeLevel({ price: 22520, strength: 0.6 }),
        ]),
      );

      const zeroDedup: SRDetectionConfig = { ...DEFAULT_CONFIG, dedupWindowSecs: 0 };
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db, zeroDedup);

      // spot 22500: distance to 22480=20≤50 ✓, distance to 22520=20≤50 ✓.
      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      // Two qualifying levels → two DB writes and two stream publishes.
      expect(db.query).toHaveBeenCalledTimes(2);
      expect(redis.xadd).toHaveBeenCalledTimes(2);
    });

    it('emits only qualifying levels when some are below the strength floor', async () => {
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([
          makeLevel({ price: 22490, strength: 0.7 }), // qualifies
          makeLevel({ price: 22510, strength: 0.1 }), // below floor=0.2
        ]),
      );

      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      // Only the first level qualifies.
      expect(db.query).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // 11. Malformed snapshot
  // --------------------------------------------------------------------------

  describe('malformed snapshot', () => {
    it('handles missing underlying field gracefully without throwing', async () => {
      const engine = makeEngine();

      await expect(
        engine._handleSnapshot({
          time: String(SIGNAL_TIME_MS),
          spot: '22500',
          atmStrike: '22500',
          straddleValue: '400',
          // no underlying
        }),
      ).resolves.toBeUndefined();
    });

    it('handles non-numeric spot gracefully without throwing', async () => {
      const engine = makeEngine();

      await expect(
        engine._handleSnapshot({
          time: String(SIGNAL_TIME_MS),
          underlying: 'NIFTY',
          spot: 'not-a-number',
          atmStrike: '22500',
          straddleValue: '400',
        }),
      ).resolves.toBeUndefined();
    });

    it('skips zero straddleValue snapshots', async () => {
      const redis = makeRedis();
      const db = makeDb();
      const engine = makeEngine(redis, db);

      await engine._handleSnapshot(makeFields({ straddleValue: 0, spot: 22500 }));

      expect(db.query).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 12. Confidence tier derivation
  // --------------------------------------------------------------------------

  describe('confidence tier', () => {
    it('derives HIGH tier from strength >= 0.6', async () => {
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([makeLevel({ price: 22500, strength: 0.8 })]),
      );

      const db = makeDb();
      const engine = makeEngine(makeRedis(), db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      // $10 (index 9): confidence_tier
      expect(callArgs[1][9]).toBe('HIGH');
    });

    it('derives MEDIUM tier from strength in [0.35, 0.6)', async () => {
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([makeLevel({ price: 22500, strength: 0.5 })]),
      );

      const db = makeDb();
      const engine = makeEngine(makeRedis(), db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(callArgs[1][9]).toBe('MEDIUM');
    });

    it('derives LOW tier from strength below 0.35', async () => {
      vi.mocked(computeSRLevels).mockResolvedValue(
        makeLevelResult([makeLevel({ price: 22500, strength: 0.25 })]),
      );

      const db = makeDb();
      const engine = makeEngine(makeRedis(), db);

      await engine._handleSnapshot(makeFields({ spot: 22500 }));

      const callArgs = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(callArgs[1][9]).toBe('LOW');
    });
  });
});
