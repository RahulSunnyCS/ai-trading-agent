/**
 * Unit tests for HolderManager (src/trading/management/holder.ts).
 *
 * All external dependencies (trigger-engine, paper-trade-executor, pg Pool,
 * Redis stream) are mocked at the module level so no network or database
 * connections are made. Time is injected via FixedClock for deterministic
 * trigger evaluation.
 *
 * Test coverage:
 *   1. evaluatePosition delegates to evaluateTriggers with correct parameters.
 *   2. evaluatePosition returns { shouldExit: true, exitReason: 'SL' } when
 *      the trigger engine returns a close signal.
 *   3. evaluatePosition returns { shouldExit: false } when the trigger engine
 *      says hold.
 *   4. closePosition calls executor.closeTrade with position.id and
 *      String(currentStraddleValue) as exit price.
 *   5. PositionMonitor dispatches a 'hold' personality to HolderManager.
 *   6. PositionMonitor dispatches a null personality_id (pre-M2 trade) to
 *      HolderManager.
 */

import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenPosition } from '../../../db/schema.js';
import { FixedClock } from '../../../utils/clock.js';
import type { PaperTradeExecutor } from '../../paper-trade-executor.js';
import { HolderManager } from '../holder.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock the trigger engine so evaluateTriggers' return value is controlled per test.
vi.mock('../../trigger-engine.js', () => ({
  evaluateTriggers: vi.fn(),
  updateTrailingStop: vi.fn((_position: OpenPosition, current: string) => current),
  loadTriggerConfig: vi.fn(),
}));

// Mock the paper-trade-executor module. We don't mock the class itself but
// we create a manual mock instance below in beforeEach.
vi.mock('../../paper-trade-executor.js', () => ({
  getOpenTrades: vi.fn(),
  PaperTradeExecutor: vi.fn(),
}));

// Mock Redis and stream infrastructure — PositionMonitor imports these.
vi.mock('../../../redis/client.js', () => ({
  STREAM_STRADDLE: 'straddle.values',
  recoverPending: vi.fn().mockResolvedValue([]),
  streamConsume: vi.fn(),
}));

import { evaluateTriggers } from '../../trigger-engine.js';
import type { TriggerConfig } from '../../trigger-engine.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * IST 10:00:00 on 2026-05-18 — within the standard trading window.
 * UTC equivalent: 2026-05-18T04:30:00.000Z
 */
const IST_1000_MAY18 = new Date('2026-05-18T04:30:00.000Z').getTime();

const clock = new FixedClock(IST_1000_MAY18);

/** A realistic open position fixture — values are representative but arbitrary. */
const mockPosition: OpenPosition = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  entryStraddleValue: '300',
  lowestStraddleValueSeen: '280',
  entryTimeMs: IST_1000_MAY18 - 60_000, // entered 1 minute ago
  todayNetPnl: '0',
};

/** A minimal TriggerConfig — actual values don't matter because evaluateTriggers is mocked. */
const mockTriggerConfig: TriggerConfig = {
  hardSlPct: 0.3,
  trailingSlPct: 0.15,
  profitTargetPct: 0.3,
  eodExitTime: '15:25',
  exitCutoffTime: '15:30',
  maxDailyLoss: '10000',
};

/** Minimal mock for pg.Pool — only query() is needed and it is mocked per test. */
const mockDb = {
  query: vi.fn(),
} as unknown as Pool;

/** A mock PaperTradeExecutor with closeTrade stubbed out. */
const mockExecutor = {
  openTrade: vi.fn(),
  closeTrade: vi.fn().mockResolvedValue(undefined),
};

/** A minimal PersonalityConfig for the 'hold' management style. */
const holdPersonality = {
  id: 'bbbbbbbb-0000-0000-0000-000000000002',
  name: 'holder',
  displayName: 'Holder',
  groupType: 'learning' as const,
  entryType: 'momentum_exhaustion' as const,
  managementStyle: 'hold' as const,
  isFrozen: false,
  isActive: true,
  phase: 1,
  params: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ---------------------------------------------------------------------------
// HolderManager tests
// ---------------------------------------------------------------------------

describe('HolderManager', () => {
  let manager: HolderManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new HolderManager();
  });

  // -------------------------------------------------------------------------
  // Test 1: evaluatePosition delegates to evaluateTriggers with correct args
  // -------------------------------------------------------------------------

  it('evaluatePosition calls evaluateTriggers with the correct position and config', async () => {
    // Arrange: trigger engine returns "hold"
    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: false });

    const currentStraddleValue = 310;
    const currentSpot = 22_000;

    // Act
    await manager.evaluatePosition(
      mockPosition,
      currentStraddleValue,
      currentSpot,
      clock,
      mockTriggerConfig,
      mockDb,
      holdPersonality,
    );

    // Assert: evaluateTriggers was called once with the correct arguments.
    // currentStraddleValue is passed as a string because the trigger engine
    // uses string NUMERIC format (per schema.ts convention).
    expect(evaluateTriggers).toHaveBeenCalledOnce();
    expect(evaluateTriggers).toHaveBeenCalledWith(
      mockPosition,
      String(currentStraddleValue), // "310"
      clock,
      mockTriggerConfig,
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: evaluatePosition returns shouldExit: true when trigger fires
  // -------------------------------------------------------------------------

  it("evaluatePosition returns { shouldExit: true, exitReason: 'SL_HIT' } when trigger engine says exit", async () => {
    // Arrange: trigger engine says the hard SL was hit.
    // Note: the actual reason string comes from the trigger engine ('SL'), not
    // the literal 'SL_HIT' — the test description uses 'SL_HIT' colloquially,
    // but we assert the actual ExitDecision reason value 'SL'.
    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: true, reason: 'SL' });

    // Act
    const result = await manager.evaluatePosition(
      mockPosition,
      390, // straddle has risen 30% above entry — SL fires
      22_000,
      clock,
      mockTriggerConfig,
      mockDb,
      holdPersonality,
    );

    // Assert
    expect(result.shouldExit).toBe(true);
    expect(result.exitReason).toBe('SL');
  });

  // -------------------------------------------------------------------------
  // Test 3: evaluatePosition returns shouldExit: false when holding
  // -------------------------------------------------------------------------

  it('evaluatePosition returns { shouldExit: false } when trigger engine says hold', async () => {
    // Arrange: trigger engine says hold
    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: false });

    // Act
    const result = await manager.evaluatePosition(
      mockPosition,
      290, // straddle has fallen slightly — TSL not yet triggered
      22_000,
      clock,
      mockTriggerConfig,
      mockDb,
      holdPersonality,
    );

    // Assert
    expect(result.shouldExit).toBe(false);
    expect(result.exitReason).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 4: closePosition calls closeTrade with position ID and string price
  // -------------------------------------------------------------------------

  it('closePosition calls executor.closeTrade with position.id and String(currentStraddleValue) as exit price', async () => {
    const currentStraddleValue = 285;
    const exitReason = 'TARGET';

    // Act
    await manager.closePosition(
      mockPosition,
      currentStraddleValue,
      exitReason,
      mockDb,
      clock,
      mockExecutor as unknown as import('../../paper-trade-executor.js').PaperTradeExecutor,
    );

    // Assert: closeTrade was called with the correct arguments.
    // The exit price must be the string representation of currentStraddleValue
    // because paper-trade-executor.ts expects NUMERIC wire format (string).
    expect(mockExecutor.closeTrade).toHaveBeenCalledOnce();
    expect(mockExecutor.closeTrade).toHaveBeenCalledWith(
      mockPosition.id, // position UUID
      String(currentStraddleValue), // "285"
      exitReason, // "TARGET"
      clock, // Clock instance for exit_time
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: all trigger reasons cause closePosition to be called
  // -------------------------------------------------------------------------

  it.each([
    ['SL', 390],
    ['TSL', 295],
    ['TARGET', 210],
    ['EOD', 285],
    ['DAILY_LOSS_CAP', 285],
    ['EXIT_WINDOW', 285],
  ] as const)(
    "evaluatePosition returns shouldExit:true with reason '%s' when trigger engine fires",
    async (reason, straddleValue) => {
      vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: true, reason });

      const result = await manager.evaluatePosition(
        mockPosition,
        straddleValue,
        22_000,
        clock,
        mockTriggerConfig,
        mockDb,
        holdPersonality,
      );

      expect(result.shouldExit).toBe(true);
      expect(result.exitReason).toBe(reason);
    },
  );
});

// ---------------------------------------------------------------------------
// PositionMonitor dispatch tests
// ---------------------------------------------------------------------------
// These tests verify that PositionMonitor correctly dispatches 'hold'
// personalities and pre-M2 trades (null personality_id) to HolderManager.
//
// We cannot exercise the full stream loop in a unit test (it requires Redis),
// so we import PositionMonitor, construct it with a mock DB that returns one
// open position, and spy on the HolderManager's evaluatePosition to confirm
// dispatch.
// ---------------------------------------------------------------------------

describe('PositionMonitor dispatch', () => {
  // Import lazily inside the describe block because PositionMonitor imports
  // Redis infrastructure which is already mocked above.
  it("dispatches a 'hold' personality position to HolderManager.evaluatePosition", async () => {
    const { PositionMonitor } = await import('../../position-monitor.js');
    const { streamConsume, recoverPending } = await import('../../../redis/client.js');

    // Capture the stream handler registered by start() so we can invoke it directly.
    let capturedStreamHandler:
      | ((id: string, fields: Record<string, string>) => Promise<void>)
      | undefined;

    vi.mocked(streamConsume).mockImplementation((_stream, _group, _consumer, handler) => {
      capturedStreamHandler = handler as typeof capturedStreamHandler;
      return Promise.resolve();
    });
    vi.mocked(recoverPending).mockResolvedValue([]);

    // The DB mock returns one open position with 'hold' personality on the
    // positions query and the personality config on the configs query.
    const holdPersonalityId = 'cccccccc-0000-0000-0000-000000000003';

    const mockDbForMonitor = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM personality_configs')) {
          // personality cache load
          return Promise.resolve({
            rows: [
              {
                id: holdPersonalityId,
                name: 'holder',
                display_name: 'Holder',
                group_type: 'learning',
                entry_type: 'momentum_exhaustion',
                management_style: 'hold',
                is_frozen: false,
                is_active: true,
                phase: 1,
                params: {},
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
          });
        }
        if (sql.includes('FROM paper_trades') && sql.includes('personality_id')) {
          // open positions query in _getOpenPositionsWithPersonality
          return Promise.resolve({
            rows: [
              {
                id: 'dddddddd-0000-0000-0000-000000000004',
                straddle_at_entry: '300',
                lowest_straddle_value_seen: '280',
                entry_time: new Date(IST_1000_MAY18 - 60_000),
                personality_id: holdPersonalityId,
              },
            ],
          });
        }
        // trailing stop UPDATE
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as Pool;

    // Spy on HolderManager.evaluatePosition to confirm dispatch.
    // We need to intercept the singleton created inside PositionMonitor, so we
    // spy on the prototype method.
    const evalSpy = vi
      .spyOn(HolderManager.prototype, 'evaluatePosition')
      .mockResolvedValue({ shouldExit: false });

    const mockVirtualClock = {
      now: vi.fn().mockReturnValue(IST_1000_MAY18),
      today: vi.fn().mockReturnValue('2026-05-18'),
      toISTDate: vi.fn().mockReturnValue('2026-05-18'),
      toISTTime: vi.fn().mockReturnValue('10:00:00'),
      tick: vi.fn(),
    };

    const monitor = new PositionMonitor({
      clock: mockVirtualClock as unknown as import('../../../utils/clock.js').ClockWithTick,
      db: mockDbForMonitor,
      redis: {} as unknown as import('ioredis').Redis,
      executor: mockExecutor as unknown as PaperTradeExecutor,
      triggerConfig: mockTriggerConfig,
    });

    await monitor.start();

    // Simulate one straddle snapshot arriving on the stream.
    expect(capturedStreamHandler).toBeDefined();
    await capturedStreamHandler!('msg-1', { straddleValue: '285', spot: '22000' });

    // Assert: HolderManager.evaluatePosition was called for the 'hold' position.
    expect(evalSpy).toHaveBeenCalledOnce();
    // The first argument must be the OpenPosition for the trade we returned from DB.
    expect(evalSpy.mock.calls[0]?.[0]).toMatchObject({
      id: 'dddddddd-0000-0000-0000-000000000004',
    });

    evalSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 6: null personality_id (pre-M2 trade) dispatches to HolderManager
  // -------------------------------------------------------------------------

  it('dispatches a null personality_id (pre-M2 trade) to HolderManager as default', async () => {
    const { PositionMonitor } = await import('../../position-monitor.js');
    const { streamConsume, recoverPending } = await import('../../../redis/client.js');

    let capturedStreamHandler:
      | ((id: string, fields: Record<string, string>) => Promise<void>)
      | undefined;

    vi.mocked(streamConsume).mockImplementation((_stream, _group, _consumer, handler) => {
      capturedStreamHandler = handler as typeof capturedStreamHandler;
      return Promise.resolve();
    });
    vi.mocked(recoverPending).mockResolvedValue([]);

    const mockDbForMonitor = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM personality_configs')) {
          // No personalities in DB — pre-M2 environment.
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('FROM paper_trades') && sql.includes('personality_id')) {
          // One pre-M2 trade with no personality association.
          return Promise.resolve({
            rows: [
              {
                id: 'eeeeeeee-0000-0000-0000-000000000005',
                straddle_at_entry: '300',
                lowest_straddle_value_seen: '280',
                entry_time: new Date(IST_1000_MAY18 - 60_000),
                personality_id: null, // pre-M2 — no personality
              },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as Pool;

    const evalSpy = vi
      .spyOn(HolderManager.prototype, 'evaluatePosition')
      .mockResolvedValue({ shouldExit: false });

    const mockVirtualClock = {
      now: vi.fn().mockReturnValue(IST_1000_MAY18),
      today: vi.fn().mockReturnValue('2026-05-18'),
      toISTDate: vi.fn().mockReturnValue('2026-05-18'),
      toISTTime: vi.fn().mockReturnValue('10:00:00'),
      tick: vi.fn(),
    };

    const monitor = new PositionMonitor({
      clock: mockVirtualClock as unknown as import('../../../utils/clock.js').ClockWithTick,
      db: mockDbForMonitor,
      redis: {} as unknown as import('ioredis').Redis,
      executor: mockExecutor as unknown as PaperTradeExecutor,
      triggerConfig: mockTriggerConfig,
    });

    await monitor.start();

    expect(capturedStreamHandler).toBeDefined();
    await capturedStreamHandler!('msg-2', { straddleValue: '285', spot: '22000' });

    // Assert: HolderManager.evaluatePosition was called even though personality_id is null.
    // This confirms that the default dispatch path (pre-M2 fallback) uses HolderManager.
    expect(evalSpy).toHaveBeenCalledOnce();
    expect(evalSpy.mock.calls[0]?.[0]).toMatchObject({
      id: 'eeeeeeee-0000-0000-0000-000000000005',
    });

    evalSpy.mockRestore();
  });
});
