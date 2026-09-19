/**
 * Unit tests for ReducerManager (src/trading/management/reducer.ts).
 *
 * All external dependencies (trigger-engine, paper-trade-executor, pg Pool)
 * are mocked so no network or database connections are made. Time is injected
 * via FixedClock for deterministic date comparisons.
 *
 * Test coverage:
 *   1. Cut fires when |currentSpot - spot_at_entry| >= cut_trigger_points.
 *   2. Cut does NOT fire when |currentSpot - spot_at_entry| < cut_trigger_points;
 *      evaluateTriggers is called instead (delegation path).
 *   3. closePosition with exitReason='CUT' sets re-entry eligible state.
 *   4. isReentryEligible returns true after a CUT on the same day.
 *   5. isReentryEligible returns false after a date change (yesterday's state).
 *   6. clearReentry removes the eligible state.
 *   7. resetReentryState removes the eligible state.
 *   8. Non-CUT exit (SL_HIT) does NOT set re-entry state.
 *   9. evaluateTriggers is called for SL/TSL/TARGET when spot is within cut_trigger_points.
 */

import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenPosition, PersonalityConfigM2 as PersonalityConfig } from '../../../db/schema.js';
import { FixedClock } from '../../../utils/clock.js';
import type { PaperTradeExecutor } from '../../paper-trade-executor.js';
import type { TriggerConfig } from '../../trigger-engine.js';
import { ReducerManager } from '../reducer.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock evaluateTriggers so the return value can be controlled per test.
// This is essential so cut-trigger tests do not accidentally fire an SL/TSL exit
// when we only want to verify the cut path.
vi.mock('../../trigger-engine.js', () => ({
  evaluateTriggers: vi.fn(),
  updateTrailingStop: vi.fn((_position: OpenPosition, current: string) => current),
  loadTriggerConfig: vi.fn(),
}));

import { evaluateTriggers } from '../../trigger-engine.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * IST 10:00:00 on 2026-05-18 — mid-session, no EOD trigger.
 * UTC equivalent: 2026-05-18T04:30:00.000Z
 */
const IST_1000_MAY18_EPOCH = new Date('2026-05-18T04:30:00.000Z').getTime();

/**
 * IST 10:00:00 on 2026-05-19 — the next trading day.
 * UTC equivalent: 2026-05-19T04:30:00.000Z
 */
const IST_1000_MAY19_EPOCH = new Date('2026-05-19T04:30:00.000Z').getTime();

const clock18 = new FixedClock(IST_1000_MAY18_EPOCH);
const _clock19 = new FixedClock(IST_1000_MAY19_EPOCH);

/** An open position that entered when NIFTY spot was at 22 000. */
const POSITION_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PERSONALITY_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

const mockPosition: OpenPosition = {
  id: POSITION_ID,
  entryStraddleValue: '300',
  lowestStraddleValueSeen: '280',
  entryTimeMs: IST_1000_MAY18_EPOCH - 60_000, // entered 1 minute ago
  todayNetPnl: '0',
};

/**
 * Extended position shape passed by PositionMonitor (includes personalityId).
 * We cast when constructing because ManagementHandler only requires OpenPosition,
 * but ReducerManager inspects the extra field in closePosition.
 */
const mockPositionWithPersonality = {
  ...mockPosition,
  personalityId: PERSONALITY_ID,
} as OpenPosition & { personalityId: string };

const SPOT_AT_ENTRY = 22_000;

/** A minimal TriggerConfig — actual values don't matter because evaluateTriggers is mocked. */
const mockTriggerConfig: TriggerConfig = {
  hardSlPct: 0.3,
  trailingSlPct: 0.15,
  profitTargetPct: 0.3,
  eodExitTime: '15:25',
  exitCutoffTime: '15:30',
  maxDailyLoss: '10000',
};

/**
 * A PersonalityConfig with management_style = 'cut_reenter' and
 * cut_trigger_points = 70 (the default).
 */
const reducerPersonality: PersonalityConfig = {
  id: PERSONALITY_ID,
  name: 'reducer',
  displayName: 'Reducer',
  groupType: 'learning',
  entryType: 'momentum_exhaustion',
  managementStyle: 'cut_reenter',
  isFrozen: false,
  isActive: true,
  phase: 1,
  params: {
    cut_trigger_points: 70,
    min_probability: 0.7,
    reentry_min_probability: 0.65,
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Builds a mock pg Pool whose query() returns spot_at_entry = entrySpot
 * for any SELECT, or a no-op for UPDATE.
 *
 * Using a factory function so each test gets a fresh mock instance with
 * vi.fn() state that does not bleed across tests.
 */
function buildMockDb(entrySpot: number = SPOT_AT_ENTRY): Pool {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('spot_at_entry')) {
        return Promise.resolve({
          rows: [{ spot_at_entry: String(entrySpot) }],
        });
      }
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
}

/**
 * Builds a mock PaperTradeExecutor whose closeTrade resolves without error.
 */
function buildMockExecutor(): PaperTradeExecutor {
  return {
    openTrade: vi.fn().mockResolvedValue('new-trade-uuid'),
    closeTrade: vi.fn().mockResolvedValue(undefined),
  } as unknown as PaperTradeExecutor;
}

// ---------------------------------------------------------------------------
// Reset re-entry state between tests so static Map does not bleed state.
// ---------------------------------------------------------------------------

afterEach(() => {
  // Clear re-entry state for the personality used in these tests.
  // We call resetReentryState rather than accessing the Map directly so the
  // test stays coupled to the public API.
  ReducerManager.resetReentryState(PERSONALITY_ID);
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReducerManager — cut trigger', () => {
  let manager: ReducerManager;

  beforeEach(() => {
    manager = new ReducerManager();
  });

  // -------------------------------------------------------------------------
  // Test 1: Cut fires at cut_trigger_points
  // -------------------------------------------------------------------------

  it("returns shouldExit:true with exitReason='CUT' when |currentSpot - entrySpot| >= cut_trigger_points", async () => {
    // Arrange: spot has moved exactly cut_trigger_points (70) from entry.
    // Entry spot = 22 000; current spot = 22 070 → distance = 70 → CUT fires.
    const currentSpot = SPOT_AT_ENTRY + 70; // exactly at the threshold

    const result = await manager.evaluatePosition(
      mockPosition,
      300, // currentStraddleValue — irrelevant when cut fires
      currentSpot,
      clock18,
      mockTriggerConfig,
      buildMockDb(SPOT_AT_ENTRY),
      reducerPersonality,
    );

    expect(result.shouldExit).toBe(true);
    expect(result.exitReason).toBe('CUT');
    // evaluateTriggers must NOT be called when the cut trigger fires — we exit
    // before reaching the delegation path.
    expect(evaluateTriggers).not.toHaveBeenCalled();
  });

  it("returns shouldExit:true with exitReason='CUT' when spot moves below entry by cut_trigger_points (adverse downward move)", async () => {
    // Short straddle is adversely affected by large moves in either direction.
    // Entry spot = 22 000; current spot = 21 930 → distance = 70 → CUT fires.
    const currentSpot = SPOT_AT_ENTRY - 70;

    const result = await manager.evaluatePosition(
      mockPosition,
      300,
      currentSpot,
      clock18,
      mockTriggerConfig,
      buildMockDb(SPOT_AT_ENTRY),
      reducerPersonality,
    );

    expect(result.shouldExit).toBe(true);
    expect(result.exitReason).toBe('CUT');
  });

  it("returns shouldExit:true with exitReason='CUT' when spot moves more than cut_trigger_points", async () => {
    // Entry spot = 22 000; current spot = 22 150 → distance = 150 > 70 → CUT fires.
    const currentSpot = SPOT_AT_ENTRY + 150;

    const result = await manager.evaluatePosition(
      mockPosition,
      300,
      currentSpot,
      clock18,
      mockTriggerConfig,
      buildMockDb(SPOT_AT_ENTRY),
      reducerPersonality,
    );

    expect(result.shouldExit).toBe(true);
    expect(result.exitReason).toBe('CUT');
  });

  // -------------------------------------------------------------------------
  // Test 2: Cut does NOT fire when spot < cut_trigger_points
  // -------------------------------------------------------------------------

  it('does NOT fire cut when |currentSpot - entrySpot| < cut_trigger_points — delegates to evaluateTriggers', async () => {
    // Arrange: spot has moved 30 points — well below the 70-point threshold.
    // evaluateTriggers should be called and its result returned.
    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: false });

    const currentSpot = SPOT_AT_ENTRY + 30; // 30 < 70 → no cut

    const result = await manager.evaluatePosition(
      mockPosition,
      300,
      currentSpot,
      clock18,
      mockTriggerConfig,
      buildMockDb(SPOT_AT_ENTRY),
      reducerPersonality,
    );

    expect(result.shouldExit).toBe(false);
    // evaluateTriggers was called (delegation path executed).
    expect(evaluateTriggers).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Test 9: evaluateTriggers called for standard exits when spot is within threshold
  // -------------------------------------------------------------------------

  it('returns the trigger-engine result (SL) when spot is within cut_trigger_points', async () => {
    // evaluateTriggers returns SL — hard stop was hit at the current straddle price.
    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: true, reason: 'SL' });

    const currentSpot = SPOT_AT_ENTRY + 20; // within threshold

    const result = await manager.evaluatePosition(
      mockPosition,
      390, // straddle has risen 30% above entry → SL fires via trigger engine
      currentSpot,
      clock18,
      mockTriggerConfig,
      buildMockDb(SPOT_AT_ENTRY),
      reducerPersonality,
    );

    expect(result.shouldExit).toBe(true);
    expect(result.exitReason).toBe('SL');
    expect(evaluateTriggers).toHaveBeenCalledOnce();
    // evaluateTriggers receives currentStraddleValue as string (NUMERIC wire format)
    expect(evaluateTriggers).toHaveBeenCalledWith(mockPosition, '390', clock18, mockTriggerConfig);
  });

  it('returns the trigger-engine result (TARGET) when spot is within cut_trigger_points', async () => {
    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: true, reason: 'TARGET' });

    const result = await manager.evaluatePosition(
      mockPosition,
      210, // straddle has fallen 30% → TARGET fires
      SPOT_AT_ENTRY + 5,
      clock18,
      mockTriggerConfig,
      buildMockDb(SPOT_AT_ENTRY),
      reducerPersonality,
    );

    expect(result.shouldExit).toBe(true);
    expect(result.exitReason).toBe('TARGET');
  });

  it('uses personality.params.cut_trigger_points if provided (non-default value)', async () => {
    // Personality with a custom cut_trigger_points of 50 instead of the default 70.
    const customPersonality: PersonalityConfig = {
      ...reducerPersonality,
      params: { ...reducerPersonality.params, cut_trigger_points: 50 },
    };

    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: false });

    // Spot 60 points from entry — fires with 50-point threshold but NOT with 70.
    const currentSpot = SPOT_AT_ENTRY + 60;

    const result = await manager.evaluatePosition(
      mockPosition,
      300,
      currentSpot,
      clock18,
      mockTriggerConfig,
      buildMockDb(SPOT_AT_ENTRY),
      customPersonality,
    );

    // 60 >= 50 → CUT fires (evaluateTriggers not called).
    expect(result.shouldExit).toBe(true);
    expect(result.exitReason).toBe('CUT');
    expect(evaluateTriggers).not.toHaveBeenCalled();
  });

  it('falls back to default cut_trigger_points=70 when params.cut_trigger_points is absent', async () => {
    // Personality with no cut_trigger_points in params.
    const personalityNoParam: PersonalityConfig = {
      ...reducerPersonality,
      params: {},
    };

    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: false });

    // Spot 69 points from entry — below the default 70-point threshold.
    const currentSpot = SPOT_AT_ENTRY + 69;

    const result = await manager.evaluatePosition(
      mockPosition,
      300,
      currentSpot,
      clock18,
      mockTriggerConfig,
      buildMockDb(SPOT_AT_ENTRY),
      personalityNoParam,
    );

    // 69 < 70 → cut does NOT fire; falls through to evaluateTriggers.
    expect(result.shouldExit).toBe(false);
    expect(evaluateTriggers).toHaveBeenCalledOnce();
  });

  it('skips the cut trigger and delegates to evaluateTriggers when spot_at_entry is NULL (pre-M2 trade)', async () => {
    // DB returns no spot_at_entry (NULL) — pre-M2 trade created before the column existed.
    const dbWithNullSpot = {
      query: vi.fn().mockResolvedValue({ rows: [{ spot_at_entry: null }] }),
    } as unknown as Pool;

    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: false });

    // Even with currentSpot far from zero (no entry to compare), should not CUT.
    const result = await manager.evaluatePosition(
      mockPosition,
      300,
      99999, // spot far from 0 — would cause false CUT if null check is missing
      clock18,
      mockTriggerConfig,
      dbWithNullSpot,
      reducerPersonality,
    );

    // Cut trigger skipped → delegates to evaluateTriggers → shouldExit: false.
    expect(result.shouldExit).toBe(false);
    expect(evaluateTriggers).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Re-entry eligibility state tests
// ---------------------------------------------------------------------------

describe('ReducerManager — re-entry eligibility state', () => {
  let manager: ReducerManager;

  beforeEach(() => {
    manager = new ReducerManager();
    // Ensure clean state before each test (afterEach also cleans up, but
    // beforeEach reset is belt-and-suspenders for test isolation).
    ReducerManager.resetReentryState(PERSONALITY_ID);
  });

  // -------------------------------------------------------------------------
  // Test 3: closePosition with CUT sets re-entry eligible state
  // -------------------------------------------------------------------------

  it("sets re-entry eligible state after closePosition with exitReason='CUT'", async () => {
    const executor = buildMockExecutor();

    // Precondition: not eligible before CUT.
    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(false);

    await manager.closePosition(
      mockPositionWithPersonality,
      300,
      'CUT',
      buildMockDb(),
      clock18,
      executor,
    );

    // After CUT, the personality should be re-entry eligible for today (IST date
    // derived from clock18 which is fixed at IST 10:00 on 2026-05-18).
    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(true);
  });

  it('calls executor.closeTrade with the correct arguments during a CUT close', async () => {
    const executor = buildMockExecutor();

    await manager.closePosition(
      mockPositionWithPersonality,
      315,
      'CUT',
      buildMockDb(),
      clock18,
      executor,
    );

    expect(executor.closeTrade).toHaveBeenCalledOnce();
    expect(executor.closeTrade).toHaveBeenCalledWith(
      POSITION_ID,
      '315', // string NUMERIC format
      'CUT',
      clock18,
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: isReentryEligible returns true after CUT on same day
  // -------------------------------------------------------------------------

  it('isReentryEligible returns true after a CUT on the same IST day', async () => {
    const executor = buildMockExecutor();

    await manager.closePosition(
      mockPositionWithPersonality,
      300,
      'CUT',
      buildMockDb(),
      clock18, // IST date = 2026-05-18
      executor,
    );

    // Same day → should be true.
    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5: isReentryEligible returns false after date changes
  // -------------------------------------------------------------------------

  it('isReentryEligible returns false when queried for a different IST date (stale state from yesterday)', async () => {
    const executor = buildMockExecutor();

    // Set re-entry state for 2026-05-18.
    await manager.closePosition(
      mockPositionWithPersonality,
      300,
      'CUT',
      buildMockDb(),
      clock18, // date = 2026-05-18
      executor,
    );

    // Query for the NEXT day — the stored date is yesterday → false.
    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-19')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 6: clearReentry removes the eligible state
  // -------------------------------------------------------------------------

  it('clearReentry removes the re-entry eligible state', async () => {
    const executor = buildMockExecutor();

    // Set re-entry state.
    await manager.closePosition(
      mockPositionWithPersonality,
      300,
      'CUT',
      buildMockDb(),
      clock18,
      executor,
    );

    // Confirm it is set.
    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(true);

    // Clear it (called by PersonalityRouter after the re-entry trade is opened).
    ReducerManager.clearReentry(PERSONALITY_ID);

    // Should be false now.
    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 7: resetReentryState removes the eligible state
  // -------------------------------------------------------------------------

  it('resetReentryState removes the re-entry eligible state', async () => {
    const executor = buildMockExecutor();

    // Set re-entry state.
    await manager.closePosition(
      mockPositionWithPersonality,
      300,
      'CUT',
      buildMockDb(),
      clock18,
      executor,
    );

    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(true);

    // Reset (called by PositionMonitor at EOD).
    ReducerManager.resetReentryState(PERSONALITY_ID);

    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 8: Non-CUT exit does NOT set re-entry state
  // -------------------------------------------------------------------------

  it("closePosition with exitReason='SL' does NOT set re-entry eligible state", async () => {
    const executor = buildMockExecutor();

    await manager.closePosition(
      mockPositionWithPersonality,
      390,
      'SL',
      buildMockDb(),
      clock18,
      executor,
    );

    // SL exit is a standard loss-limit exit — no re-entry intended.
    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(false);
  });

  it("closePosition with exitReason='TARGET' does NOT set re-entry eligible state", async () => {
    const executor = buildMockExecutor();

    await manager.closePosition(
      mockPositionWithPersonality,
      210,
      'TARGET',
      buildMockDb(),
      clock18,
      executor,
    );

    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(false);
  });

  it("closePosition with exitReason='EOD' does NOT set re-entry eligible state", async () => {
    const executor = buildMockExecutor();

    await manager.closePosition(
      mockPositionWithPersonality,
      285,
      'EOD',
      buildMockDb(),
      clock18,
      executor,
    );

    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(false);
  });

  it("closePosition with exitReason='TSL' does NOT set re-entry eligible state", async () => {
    const executor = buildMockExecutor();

    await manager.closePosition(
      mockPositionWithPersonality,
      295,
      'TSL',
      buildMockDb(),
      clock18,
      executor,
    );

    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Re-entry state: cross-day isolation
  // -------------------------------------------------------------------------

  it('isReentryEligible is false for a personality that has never had a CUT', () => {
    const unknownPersonalityId = 'cccccccc-0000-0000-0000-000000000003';
    expect(ReducerManager.isReentryEligible(unknownPersonalityId, '2026-05-18')).toBe(false);
  });

  it('re-entry state is independent per personality: CUT on one does not affect another', async () => {
    const executor = buildMockExecutor();
    const otherPersonalityId = 'cccccccc-0000-0000-0000-000000000003';

    const positionForOther = {
      ...mockPositionWithPersonality,
      personalityId: PERSONALITY_ID,
    };

    await manager.closePosition(positionForOther, 300, 'CUT', buildMockDb(), clock18, executor);

    // PERSONALITY_ID is eligible; a different personality is not.
    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(true);
    expect(ReducerManager.isReentryEligible(otherPersonalityId, '2026-05-18')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // openPosition delegates to executor (basic smoke test)
  // -------------------------------------------------------------------------

  it('openPosition calls executor.openTrade and returns the new trade id', async () => {
    const executor = buildMockExecutor();

    const intent = {
      personalityId: PERSONALITY_ID,
      signalId: null,
      underlying: 'NIFTY',
      atmStrike: 22000,
      spot: SPOT_AT_ENTRY,
      straddleValue: 300,
      vix: 15.5,
      entryTime: IST_1000_MAY18_EPOCH,
    };

    const tradeId = await manager.openPosition(intent, executor, clock18);

    expect(tradeId).toBe('new-trade-uuid');
    expect(executor.openTrade).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // IST date helper: verify CUT on the boundary of IST midnight
  // -------------------------------------------------------------------------

  it('getISTDateStr produces the correct IST date near UTC midnight (IST is UTC+5:30)', async () => {
    // UTC 2026-05-18T18:30:00Z = IST 2026-05-19T00:00:00+05:30 (IST midnight)
    // A CUT at this exact moment should record date = '2026-05-19' in IST.
    const executor = buildMockExecutor();

    const utcMidnightForISTMidnight = new Date('2026-05-18T18:30:00.000Z').getTime();
    const midnightClock = new FixedClock(utcMidnightForISTMidnight);

    await manager.closePosition(
      mockPositionWithPersonality,
      300,
      'CUT',
      buildMockDb(),
      midnightClock,
      executor,
    );

    // The re-entry state date should be IST 2026-05-19, not UTC 2026-05-18.
    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-19')).toBe(true);
    expect(ReducerManager.isReentryEligible(PERSONALITY_ID, '2026-05-18')).toBe(false);
  });
});
