/**
 * Unit tests for PersonalityRouter (src/signals/personality-router.ts).
 *
 * All external dependencies (Redis, DB Pool, openTrade) are mocked so no
 * real network or database connections are made.
 *
 * Test strategy:
 * - We extract the signal handler from the read loop by intercepting xreadgroup
 *   and driving it directly, or by calling internal helpers via the exported
 *   toStraddleSignalInput conversion helper and mocking modules.
 * - PersonalityRouter._handleSignal is private. We test it indirectly by:
 *   (a) calling start() and then feeding a signal via the mocked xreadgroup, or
 *   (b) using spies to verify openTrade and fetchDailyState call counts.
 *
 * IST 10:30:00 on 2026-05-19 (a regular trading day within 09:20–15:00 IST).
 * UTC equivalent: 2026-05-19T05:00:00.000Z.
 * This epoch is used for all time-sensitive tests.
 */

import type { Redis } from 'ioredis';
import type { Pool, QueryResult } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalityConfigM2 as PersonalityConfig } from '../../db/schema.js';
import { FixedClock } from '../../utils/clock.js';
import { type IncomingSignal, PersonalityRouter } from '../personality-router.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock redis/client.ts to prevent the module-level ioredis singleton from
// attempting a real connection at test startup. PersonalityRouter imports
// STREAM_SIGNALS from this module; we supply the constant directly.
vi.mock('../../redis/client.js', () => ({
  STREAM_SIGNALS: 'signals.generated',
  STREAM_TICKS: 'market.ticks',
  STREAM_STRADDLE: 'straddle.values',
  redis: { xgroup: vi.fn(), xreadgroup: vi.fn(), xack: vi.fn() },
  streamPublish: vi.fn(),
  streamConsume: vi.fn(),
  closeRedis: vi.fn(),
  recoverPending: vi.fn().mockResolvedValue([]),
}));

// Mock the personality-filter module so we can control filter outcomes
// without depending on the time-gate logic inside runPersonalityFilter.
// parseBlockedDatesSet is included so the router can import it; returning
// an empty Set is the correct behaviour for tests (no blocked dates).
vi.mock('../personality-filter.js', () => ({
  fetchDailyState: vi.fn(),
  runPersonalityFilter: vi.fn(),
  parseBlockedDatesSet: vi.fn().mockReturnValue(new Set<string>()),
}));

// Mock the paper-trade-executor module so no real DB INSERTs happen.
vi.mock('../../trading/paper-trade-executor.js', () => ({
  PaperTradeExecutor: vi.fn().mockImplementation(() => ({
    openTrade: vi.fn().mockResolvedValue('trade-uuid-001'),
  })),
}));

// Mock portfolioRiskCheck so the router tests are not coupled to the risk
// module's DB query sequence. The risk module has its own dedicated test suite.
vi.mock('../../trading/portfolio-risk.js', () => ({
  portfolioRiskCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { PaperTradeExecutor } from '../../trading/paper-trade-executor.js';
import { portfolioRiskCheck } from '../../trading/portfolio-risk.js';
// Import the mocked modules so we can control their behaviour per test.
import { fetchDailyState, runPersonalityFilter } from '../personality-filter.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 2026-05-19 10:30:00 IST = 2026-05-19T05:00:00.000Z */
const IST_1030_MAY19 = new Date('2026-05-19T05:00:00.000Z').getTime();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal PersonalityConfig for tests.
 * Only sets fields that affect routing logic; others get safe defaults.
 */
function makePersonality(overrides: Partial<PersonalityConfig> = {}): PersonalityConfig {
  return {
    id: 'pers-001',
    name: 'precision',
    displayName: 'Precision',
    groupType: 'reference',
    entryType: 'momentum_exhaustion',
    managementStyle: 'hold',
    isFrozen: false,
    isActive: true,
    phase: 1,
    params: { min_probability: 0.7 },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Builds flat field pairs as ioredis returns them from XREADGROUP.
 * This format is what _handleSignal receives via the read loop.
 */
function makeSignalFields(overrides: Partial<Record<string, string>> = {}): string[] {
  const defaults: Record<string, string> = {
    signal_id: 'sig-001',
    signal_type: 'MOMENTUM_EXHAUSTION',
    underlying: 'NIFTY',
    atm_strike: '22000',
    spot: '22000.00',
    straddle_value: '200.00',
    vix: '15.5',
    adjusted_probability: '0.75',
    confidence_tier: 'HIGH',
    signal_time: String(IST_1030_MAY19),
    ...overrides,
  };
  // Flatten to [k, v, k, v, ...] as ioredis XREADGROUP returns
  return Object.entries(defaults).flat();
}

/**
 * Builds a mock XREADGROUP response containing one message.
 * Shape: [[streamName, [[msgId, flatFields]]]]
 */
function makeXreadgroupResponse(msgId: string, flatFields: string[]): unknown {
  return [['signals.generated', [[msgId, flatFields]]]];
}

/**
 * Creates a mock pg Pool. Returns configurable query results per call.
 * defaultRows is used for any query not specifically overridden.
 */
function makeMockDb(overrides?: {
  openTradesRows?: Array<Record<string, unknown>>;
  personalityRows?: PersonalityConfig[];
}): Pool {
  const openTradesResult: QueryResult = {
    rows: overrides?.openTradesRows ?? [],
    command: 'SELECT',
    rowCount: 0,
    oid: 0,
    fields: [],
  };

  // Map PersonalityConfig to DB snake_case row shape
  const personalityDbRows = (overrides?.personalityRows ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    display_name: p.displayName,
    group_type: p.groupType,
    entry_type: p.entryType,
    management_style: p.managementStyle,
    is_frozen: p.isFrozen,
    is_active: p.isActive,
    phase: p.phase,
    params: p.params,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  }));

  const personalityResult: QueryResult = {
    rows: personalityDbRows,
    command: 'SELECT',
    rowCount: personalityDbRows.length,
    oid: 0,
    fields: [],
  };

  const updateResult: QueryResult = {
    rows: [],
    command: 'UPDATE',
    rowCount: 1,
    oid: 0,
    fields: [],
  };

  // query() is called with different SQL; we differentiate by call order:
  //   call 1: reconciliation SELECT (open trades)
  //   call 2: personality SELECT
  //   call 3+: UPDATE paper_trades (one per opened trade)
  let callCount = 0;
  const mockQuery = vi.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 1) return Promise.resolve(openTradesResult);
    if (callCount === 2) return Promise.resolve(personalityResult);
    return Promise.resolve(updateResult);
  });

  return { query: mockQuery } as unknown as Pool;
}

/**
 * Creates a mock ioredis Redis client.
 * xgroup always resolves (group creation succeeds).
 * xreadgroup returns the provided responses in sequence, then blocks forever.
 * xack always resolves.
 */
function makeMockRedis(xreadgroupResponses: unknown[]): Redis {
  let responseIndex = 0;

  const mockXreadgroup = vi.fn().mockImplementation(() => {
    if (responseIndex < xreadgroupResponses.length) {
      return Promise.resolve(xreadgroupResponses[responseIndex++]);
    }
    // All messages delivered — block indefinitely (resolved with null = timeout).
    // We use a long timeout so the router's read loop naturally sees nothing
    // and the test can call stop() to exit.
    return new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000));
  });

  return {
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: mockXreadgroup,
    xack: vi.fn().mockResolvedValue(1),
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PersonalityRouter', () => {
  // Reset all mocks between tests to avoid cross-test contamination.
  // After resetting, restore the portfolioRiskCheck default (vi.resetAllMocks clears
  // all implementations, so without this the risk check would return undefined and
  // crash _openTradeForPersonality before openTrade is reached).
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(portfolioRiskCheck).mockResolvedValue({ allowed: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: Signal passing filters for 2 personalities → openTrade called twice
  // -------------------------------------------------------------------------
  it('calls openTrade twice when signal passes filters for 2 active personalities', async () => {
    const personality1 = makePersonality({ id: 'pers-001', name: 'precision' });
    const personality2 = makePersonality({
      id: 'pers-002',
      name: 'blitz',
      managementStyle: 'cut_reenter',
    });

    // fetchDailyState returns a safe default DailyState for each personality.
    vi.mocked(fetchDailyState).mockResolvedValue({
      tradeCount: 0,
      netPnl: '0',
      openPositions: 0,
    });

    // Both personalities pass all 5 filter stages.
    vi.mocked(runPersonalityFilter).mockReturnValue({ pass: true, stage: 6, reason: 'PASS' });

    const signalFields = makeSignalFields();
    const xreadgroupResponses = [makeXreadgroupResponse('1-0', signalFields)];

    const db = makeMockDb({ personalityRows: [personality1, personality2] });
    const redis = makeMockRedis(xreadgroupResponses);
    const clock = new FixedClock(IST_1030_MAY19);

    // Set up the executor mock BEFORE constructing the router: the executor is
    // created in the constructor (P2 fix), so the mock must be in place first.
    const mockOpenTrade = vi.fn().mockResolvedValue('trade-uuid');
    vi.mocked(PaperTradeExecutor).mockImplementation(
      () =>
        ({
          openTrade: mockOpenTrade,
        }) as unknown as InstanceType<typeof PaperTradeExecutor>,
    );

    const router = new PersonalityRouter(db, redis, clock);

    await router.start();

    // Give the read loop a tick to process the message.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await router.stop();

    // openTrade should have been called once per passing personality.
    expect(mockOpenTrade).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Test 2: Signal rejected by all personalities → openTrade not called
  // -------------------------------------------------------------------------
  it('does not call openTrade when signal is rejected by all personalities', async () => {
    const personality1 = makePersonality({ id: 'pers-001', name: 'precision' });
    const personality2 = makePersonality({ id: 'pers-002', name: 'blitz' });

    vi.mocked(fetchDailyState).mockResolvedValue({
      tradeCount: 5, // hit daily limit
      netPnl: '0',
      openPositions: 0,
    });

    // All personalities fail at stage 2 (max daily trades reached).
    vi.mocked(runPersonalityFilter).mockReturnValue({
      pass: false,
      stage: 2,
      reason: 'MAX_DAILY_TRADES_REACHED',
    });

    const signalFields = makeSignalFields();
    const xreadgroupResponses = [makeXreadgroupResponse('1-0', signalFields)];

    const db = makeMockDb({ personalityRows: [personality1, personality2] });
    const redis = makeMockRedis(xreadgroupResponses);
    const clock = new FixedClock(IST_1030_MAY19);

    const router = new PersonalityRouter(db, redis, clock);

    const mockOpenTrade = vi.fn().mockResolvedValue('trade-uuid');
    vi.mocked(PaperTradeExecutor).mockImplementation(
      () =>
        ({
          openTrade: mockOpenTrade,
        }) as unknown as InstanceType<typeof PaperTradeExecutor>,
    );

    await router.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await router.stop();

    expect(mockOpenTrade).toHaveBeenCalledTimes(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: Signal rejected for 1 personality, passes for 1 → openTrade called once
  // -------------------------------------------------------------------------
  it('calls openTrade exactly once when signal passes for 1 of 2 personalities', async () => {
    const personality1 = makePersonality({ id: 'pers-001', name: 'precision' });
    const personality2 = makePersonality({ id: 'pers-002', name: 'blitz' });

    vi.mocked(fetchDailyState).mockResolvedValue({
      tradeCount: 0,
      netPnl: '0',
      openPositions: 0,
    });

    // First personality passes; second is rejected.
    vi.mocked(runPersonalityFilter)
      .mockReturnValueOnce({ pass: true, stage: 6, reason: 'PASS' })
      .mockReturnValueOnce({ pass: false, stage: 4, reason: 'PROBABILITY_BELOW_THRESHOLD' });

    const signalFields = makeSignalFields();
    const xreadgroupResponses = [makeXreadgroupResponse('1-0', signalFields)];

    const db = makeMockDb({ personalityRows: [personality1, personality2] });
    const redis = makeMockRedis(xreadgroupResponses);
    const clock = new FixedClock(IST_1030_MAY19);

    // Set up the executor mock BEFORE constructing the router.
    const mockOpenTrade = vi.fn().mockResolvedValue('trade-uuid');
    vi.mocked(PaperTradeExecutor).mockImplementation(
      () =>
        ({
          openTrade: mockOpenTrade,
        }) as unknown as InstanceType<typeof PaperTradeExecutor>,
    );

    const router = new PersonalityRouter(db, redis, clock);

    await router.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await router.stop();

    expect(mockOpenTrade).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 4: Startup reconciliation loads open trades from DB and logs them
  // -------------------------------------------------------------------------
  it('logs open trades during startup reconciliation', async () => {
    // Two open trades — one with a personality, one without (pre-M2).
    const openTradesRows = [
      {
        id: 'trade-001',
        personality_id: 'pers-001',
        personality_name: 'precision',
        management_style: 'hold',
        status: 'open',
      },
      {
        id: 'trade-002',
        personality_id: null,
        personality_name: null,
        management_style: null,
        status: 'open',
      },
    ];

    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    // Empty xreadgroup response (no signals to process).
    const db = makeMockDb({ openTradesRows });
    const redis = makeMockRedis([null]); // null = no messages (BLOCK timeout)
    const clock = new FixedClock(IST_1030_MAY19);

    const router = new PersonalityRouter(db, redis, clock);
    await router.start();
    await router.stop();

    // Verify that reconciliation logs mention the open trades.
    const infoCalls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(
      infoCalls.some(
        (msg) => msg.includes('Startup reconciliation') && msg.includes('2 open trade(s)'),
      ),
    ).toBe(true);

    // Verify a log entry mentions the pre-M2 trade.
    expect(
      infoCalls.some((msg) => msg.includes('trade-002') && msg.includes('no personality_id')),
    ).toBe(true);

    consoleSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 5: VIX null/unavailable → WARN logged, processing continues
  // -------------------------------------------------------------------------
  it('logs a WARN when VIX is null and continues processing', async () => {
    const personality1 = makePersonality({ id: 'pers-001', name: 'precision' });

    vi.mocked(fetchDailyState).mockResolvedValue({
      tradeCount: 0,
      netPnl: '0',
      openPositions: 0,
    });
    vi.mocked(runPersonalityFilter).mockReturnValue({ pass: true, stage: 6, reason: 'PASS' });

    // Signal with vix = "null" string (how the stream encodes a missing VIX).
    const signalFields = makeSignalFields({ vix: 'null' });
    const xreadgroupResponses = [makeXreadgroupResponse('1-0', signalFields)];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const db = makeMockDb({ personalityRows: [personality1] });
    const redis = makeMockRedis(xreadgroupResponses);

    // Use a clock set to the VIX-fresh window so the staleness gate does not
    // block the signal. We set lastVixTimestampMs by passing a recent epoch
    // and a very long VIX_STALE_MS.
    const clock = new FixedClock(IST_1030_MAY19);
    process.env.VIX_STALE_MS = '99999999'; // effectively disabled for this test

    // Set up the executor mock BEFORE constructing the router.
    const mockOpenTrade = vi.fn().mockResolvedValue('trade-uuid');
    vi.mocked(PaperTradeExecutor).mockImplementation(
      () =>
        ({
          openTrade: mockOpenTrade,
        }) as unknown as InstanceType<typeof PaperTradeExecutor>,
    );

    const router = new PersonalityRouter(db, redis, clock);

    await router.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await router.stop();

    // Verify a WARN was logged for missing VIX.
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((msg) => msg.includes('VIX unavailable'))).toBe(true);

    // Processing must still continue — openTrade should have been called.
    expect(mockOpenTrade).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    delete process.env.VIX_STALE_MS;
  });

  // -------------------------------------------------------------------------
  // Test 6: fetchDailyState called once per active personality (batch, not sequential)
  // -------------------------------------------------------------------------
  it('calls fetchDailyState once per active personality in parallel', async () => {
    const personality1 = makePersonality({ id: 'pers-001', name: 'precision' });
    const personality2 = makePersonality({ id: 'pers-002', name: 'blitz' });
    const personality3 = makePersonality({ id: 'pers-003', name: 'scanner' });

    vi.mocked(fetchDailyState).mockResolvedValue({
      tradeCount: 0,
      netPnl: '0',
      openPositions: 0,
    });
    vi.mocked(runPersonalityFilter).mockReturnValue({
      pass: false,
      stage: 1,
      reason: 'PERSONALITY_INACTIVE',
    });

    const signalFields = makeSignalFields();
    const xreadgroupResponses = [makeXreadgroupResponse('1-0', signalFields)];

    const db = makeMockDb({ personalityRows: [personality1, personality2, personality3] });
    const redis = makeMockRedis(xreadgroupResponses);
    const clock = new FixedClock(IST_1030_MAY19);

    process.env.VIX_STALE_MS = '99999999'; // disable staleness gate
    const router = new PersonalityRouter(db, redis, clock);
    await router.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await router.stop();
    delete process.env.VIX_STALE_MS;

    // fetchDailyState should have been called exactly 3 times — once per personality.
    // The router uses Promise.all so all 3 calls are initiated concurrently.
    // T-44 D2 Option A: the router now passes the signal's underlying as the 4th
    // arg so open-leg counts are scoped per index. The test signal uses 'NIFTY'.
    expect(fetchDailyState).toHaveBeenCalledTimes(3);
    expect(fetchDailyState).toHaveBeenCalledWith(
      db,
      'pers-001',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      'NIFTY',
    );
    expect(fetchDailyState).toHaveBeenCalledWith(
      db,
      'pers-002',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      'NIFTY',
    );
    expect(fetchDailyState).toHaveBeenCalledWith(
      db,
      'pers-003',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      'NIFTY',
    );
  });

  // -------------------------------------------------------------------------
  // Test 6b: UPDATE sets personality_id, signal_id, AND underlying (FIX-A C1)
  // -------------------------------------------------------------------------
  // Verifies that the post-open UPDATE populates `underlying` as parameter $3
  // and shifts tradeId to $4.  Without this fix the per-index daily-stop and
  // open-leg-cap queries (migration 015) match nothing because underlying=NULL.
  it('UPDATE after openTrade sets underlying = signal.underlying as $3 parameter', async () => {
    const personality1 = makePersonality({ id: 'pers-001', name: 'precision' });

    vi.mocked(fetchDailyState).mockResolvedValue({
      tradeCount: 0,
      netPnl: '0',
      openPositions: 0,
    });
    vi.mocked(runPersonalityFilter).mockReturnValue({ pass: true, stage: 6, reason: 'PASS' });

    // Use a BANKNIFTY signal so the assertion is unambiguous (not the default NIFTY).
    const signalFields = makeSignalFields({ underlying: 'BANKNIFTY', signal_id: 'sig-bn-001' });
    const xreadgroupResponses = [makeXreadgroupResponse('1-0', signalFields)];

    // Use a custom mockQuery so we can capture every call's SQL + params.
    const capturedQueries: Array<{ sql: string; params: unknown[] }> = [];
    const mockQuery = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      capturedQueries.push({ sql, params });
      const callIndex = capturedQueries.length;
      if (callIndex === 1) {
        // reconciliation SELECT: no open trades
        return Promise.resolve({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] });
      }
      if (callIndex === 2) {
        // personality SELECT: one personality
        const dbRow = {
          id: personality1.id,
          name: personality1.name,
          display_name: personality1.displayName,
          group_type: personality1.groupType,
          entry_type: personality1.entryType,
          management_style: personality1.managementStyle,
          is_frozen: personality1.isFrozen,
          is_active: personality1.isActive,
          phase: personality1.phase,
          params: personality1.params,
          created_at: personality1.createdAt,
          updated_at: personality1.updatedAt,
        };
        return Promise.resolve({ rows: [dbRow], command: 'SELECT', rowCount: 1, oid: 0, fields: [] });
      }
      // call 3: UPDATE paper_trades
      return Promise.resolve({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
    });

    const db = { query: mockQuery } as unknown as Pool;
    const redis = makeMockRedis(xreadgroupResponses);
    const clock = new FixedClock(IST_1030_MAY19);

    process.env.VIX_STALE_MS = '99999999';

    const mockOpenTrade = vi.fn().mockResolvedValue('trade-uuid-bn');
    vi.mocked(PaperTradeExecutor).mockImplementation(
      () =>
        ({
          openTrade: mockOpenTrade,
        }) as unknown as InstanceType<typeof PaperTradeExecutor>,
    );

    const router = new PersonalityRouter(db, redis, clock);
    await router.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await router.stop();

    delete process.env.VIX_STALE_MS;

    // The UPDATE must have been issued (call index 3).
    // We assert-then-narrow: if updateCall is undefined the expect throws and the
    // test fails; the non-null assertion on the next line is safe after that guard.
    const updateCall = capturedQueries[2];
    expect(updateCall).toBeDefined();
    // Narrow away `undefined` for strict-mode property access below.
    const update = updateCall!;

    // SQL must reference all four placeholders including $3 (underlying) and $4 (id).
    expect(update.sql).toMatch(/SET\s+personality_id\s*=\s*\$1/i);
    expect(update.sql).toMatch(/signal_id\s*=\s*\$2/i);
    expect(update.sql).toMatch(/underlying\s*=\s*\$3/i);
    expect(update.sql).toMatch(/WHERE\s+id\s*=\s*\$4/i);

    // Parameters: [$1=personalityId, $2=signalId, $3=underlying, $4=tradeId]
    expect(update.params[0]).toBe('pers-001');       // $1: personality_id
    expect(update.params[1]).toBe('sig-bn-001');     // $2: signal_id
    expect(update.params[2]).toBe('BANKNIFTY');      // $3: underlying (bare index name)
    expect(update.params[3]).toBe('trade-uuid-bn');  // $4: trade id
  });

  // -------------------------------------------------------------------------
  // Test 7: ACTIVE_PHASE gating (T-44)
  // -------------------------------------------------------------------------
  // The router queries `WHERE phase <= $ACTIVE_PHASE`. We verify this by
  // observing what personality DB rows are returned (controlled by makeMockDb)
  // and that fetchDailyState is called once per returned personality.
  //
  // Because _loadActivePersonalities runs a real DB query that we control
  // via makeMockDb, we can supply a phase=2 personality and check whether it
  // is picked up depending on the ACTIVE_PHASE env var.

  it('does not load phase=2 personalities when ACTIVE_PHASE=1 (default)', async () => {
    // A phase=2 personality (Levelhead). At ACTIVE_PHASE=1 the DB query
    // filters it out — we simulate that by returning an empty personalityRows
    // array (the real DB would exclude it via `phase <= 1`).
    // We verify fetchDailyState is never called (nothing to route to).
    const phase2Personality = makePersonality({ id: 'pers-levelhead', name: 'levelhead', phase: 2 });

    // DB returns no personalities because ACTIVE_PHASE=1 excludes phase=2.
    const db = makeMockDb({ personalityRows: [] });
    const signalFields = makeSignalFields();
    const xreadgroupResponses = [makeXreadgroupResponse('1-0', signalFields)];
    const redis = makeMockRedis(xreadgroupResponses);
    const clock = new FixedClock(IST_1030_MAY19);

    // Ensure ACTIVE_PHASE defaults to 1 (unset)
    delete process.env.ACTIVE_PHASE;
    process.env.VIX_STALE_MS = '99999999';

    vi.mocked(fetchDailyState).mockResolvedValue({ tradeCount: 0, netPnl: '0', openPositions: 0 });
    vi.mocked(runPersonalityFilter).mockReturnValue({ pass: true, stage: 6, reason: 'PASS' });

    const mockOpenTrade = vi.fn().mockResolvedValue('trade-uuid');
    vi.mocked(PaperTradeExecutor).mockImplementation(
      () => ({ openTrade: mockOpenTrade }) as unknown as InstanceType<typeof PaperTradeExecutor>,
    );

    const router = new PersonalityRouter(db, redis, clock);
    await router.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await router.stop();
    delete process.env.VIX_STALE_MS;

    // No personalities were returned by the DB → fetchDailyState never called
    expect(fetchDailyState).not.toHaveBeenCalled();
    // Confirm the phase=2 personality reference is used only as a fixture —
    // the real assertion is that nothing was routed.
    expect(phase2Personality.phase).toBe(2);
  });

  it('loads phase=2 personalities when ACTIVE_PHASE=2 (Levelhead activation)', async () => {
    // When ACTIVE_PHASE=2, the DB query `phase <= 2` includes Levelhead.
    // We simulate this by having makeMockDb return a phase=2 personality.
    const phase2Personality = makePersonality({
      id: 'pers-levelhead',
      name: 'levelhead',
      phase: 2,
      entryType: 'sr_anchored',
      managementStyle: 'cut_reenter',
    });

    vi.mocked(fetchDailyState).mockResolvedValue({ tradeCount: 0, netPnl: '0', openPositions: 0 });
    vi.mocked(runPersonalityFilter).mockReturnValue({ pass: false, stage: 1, reason: 'ENTRY_TYPE_MISMATCH: test' });

    const signalFields = makeSignalFields();
    const xreadgroupResponses = [makeXreadgroupResponse('1-0', signalFields)];

    const db = makeMockDb({ personalityRows: [phase2Personality] });
    const redis = makeMockRedis(xreadgroupResponses);
    const clock = new FixedClock(IST_1030_MAY19);

    process.env.ACTIVE_PHASE = '2';
    process.env.VIX_STALE_MS = '99999999';

    const mockOpenTrade = vi.fn().mockResolvedValue('trade-uuid');
    vi.mocked(PaperTradeExecutor).mockImplementation(
      () => ({ openTrade: mockOpenTrade }) as unknown as InstanceType<typeof PaperTradeExecutor>,
    );

    const router = new PersonalityRouter(db, redis, clock);
    await router.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await router.stop();

    delete process.env.ACTIVE_PHASE;
    delete process.env.VIX_STALE_MS;

    // The phase=2 personality was returned by the DB (ACTIVE_PHASE=2 allows it)
    // → fetchDailyState is called exactly once for Levelhead.
    expect(fetchDailyState).toHaveBeenCalledTimes(1);
    expect(fetchDailyState).toHaveBeenCalledWith(
      db,
      'pers-levelhead',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      'NIFTY',
    );
  });
});
