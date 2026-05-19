/**
 * Unit tests for AdjusterManager (src/trading/management/adjuster.ts).
 *
 * All external dependencies (trigger-engine, paper-trade-executor, pg Pool)
 * are mocked so no database or network connections are made.
 *
 * Test coverage:
 *   1. Roll fires when |currentSpot - entrySpotProxy| >= roll_trigger_points.
 *   2. Roll does NOT fire when spot move is below roll_trigger_points
 *      (falls through to evaluateTriggers).
 *   3. max_open_legs cap prevents roll when openLegs >= max_open_legs / 2 —
 *      position is treated as Holder (delegates to evaluateTriggers).
 *   4. Roll at exactly the threshold (boundary: >= not >).
 *   5. closePosition ROLL path: BEGIN, UPDATE closed trade, INSERT new trade
 *      with parent_trade_id set, COMMIT — all on the same client.
 *   6. closePosition ROLL path: ROLLBACK is called if the INSERT fails.
 *   7. closePosition non-ROLL (SL_HIT): delegates to executor.closeTrade,
 *      no transaction started.
 *   8. evaluateTriggers is called for standard exits when below roll threshold.
 */

import type { Pool, PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenPosition, PersonalityConfig } from "../../../db/schema.js";
import { FixedClock } from "../../../utils/clock.js";
import { AdjusterManager } from "../adjuster.js";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock the trigger engine so evaluateTriggers return value is controlled per test.
vi.mock("../../trigger-engine.js", () => ({
  evaluateTriggers: vi.fn(),
  updateTrailingStop: vi.fn((position: OpenPosition, current: string) => current),
  loadTriggerConfig: vi.fn(),
}));

// Mock the paper-trade-executor module.
vi.mock("../../paper-trade-executor.js", () => ({
  getOpenTrades: vi.fn(),
  PaperTradeExecutor: vi.fn(),
}));

import { evaluateTriggers } from "../../trigger-engine.js";
import type { TriggerConfig } from "../../trigger-engine.js";
import type { PaperTradeExecutor } from "../../paper-trade-executor.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * IST 10:00:00 on 2026-05-18 — within the standard trading window.
 * UTC equivalent: 2026-05-18T04:30:00.000Z
 */
const IST_1000_MAY18 = new Date("2026-05-18T04:30:00.000Z").getTime();
const clock = new FixedClock(IST_1000_MAY18);

/**
 * An open position whose entryStraddleValue is "300". This doubles as the
 * entry spot proxy in evaluatePosition (M2 accepted limitation — see adjuster.ts).
 * The entry spot proxy = 300.
 */
const mockPosition: OpenPosition = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  entryStraddleValue: "300", // also used as entry spot proxy
  lowestStraddleValueSeen: "280",
  entryTimeMs: IST_1000_MAY18 - 60_000, // entered 1 minute ago
  todayNetPnl: "0",
};

const mockTriggerConfig: TriggerConfig = {
  hardSlPct: 0.3,
  trailingSlPct: 0.15,
  profitTargetPct: 0.3,
  eodExitTime: "15:25",
  exitCutoffTime: "15:30",
  maxDailyLoss: "10000",
};

/**
 * A personality configured for "roll" management with default roll parameters.
 * roll_trigger_points = 70, max_open_legs = 4.
 */
const rollPersonality: PersonalityConfig = {
  id: "cccccccc-0000-0000-0000-000000000002",
  name: "adjuster",
  displayName: "Adjuster",
  groupType: "learning",
  entryType: "momentum_exhaustion",
  managementStyle: "roll",
  isFrozen: false,
  isActive: true,
  phase: 1,
  params: {
    roll_trigger_points: 70,
    max_open_legs: 4,
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Creates a minimal mock PoolClient for transaction testing.
 *
 * The query mock is wired in individual tests to control what each query
 * call returns. We use a shared mock function so we can assert the call
 * sequence (BEGIN → SELECT → UPDATE → INSERT → COMMIT).
 */
function makeMockClient(queryResponses: Array<unknown>): PoolClient {
  let callIndex = 0;
  const queryMock = vi.fn().mockImplementation(() => {
    const response = queryResponses[callIndex++];
    if (response instanceof Error) {
      return Promise.reject(response);
    }
    return Promise.resolve(response);
  });

  return {
    query: queryMock,
    release: vi.fn(),
  } as unknown as PoolClient;
}

/**
 * Creates a minimal mock Pool that returns a mock client from connect().
 */
function makeMockDb(client: PoolClient, openLegsCount = 0): Pool {
  return {
    // query() is called for the COUNT open_legs check in evaluatePosition.
    query: vi.fn().mockResolvedValue({ rows: [{ cnt: openLegsCount }] }),
    // connect() is called in closePosition for the ROLL transaction.
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

/** A mock PaperTradeExecutor with closeTrade stubbed out. */
const mockExecutor = {
  openTrade: vi.fn(),
  closeTrade: vi.fn().mockResolvedValue(undefined),
} as unknown as PaperTradeExecutor;

// ---------------------------------------------------------------------------
// Tests: evaluatePosition
// ---------------------------------------------------------------------------

describe("AdjusterManager.evaluatePosition", () => {
  let manager: AdjusterManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AdjusterManager();
    // Default: evaluateTriggers says hold (most tests override this when needed).
    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: false });
  });

  // -------------------------------------------------------------------------
  // Test 1: Roll fires when spot has moved >= roll_trigger_points
  // -------------------------------------------------------------------------

  it("returns ROLL when |currentSpot - entrySpotProxy| >= roll_trigger_points", async () => {
    // entryStraddleValue is "300" (used as entry spot proxy).
    // currentSpot = 300 + 70 = 370 → spotsFromEntry = 70 → fires at exactly the threshold.
    const mockDb = makeMockDb(makeMockClient([]), /* openLegs */ 0);

    const result = await manager.evaluatePosition(
      mockPosition,
      310,   // currentStraddleValue — irrelevant for the roll check
      370,   // currentSpot — 70 points above entry proxy
      clock,
      mockTriggerConfig,
      mockDb,
      rollPersonality,
    );

    expect(result.shouldExit).toBe(true);
    expect(result.exitReason).toBe("ROLL");
    // evaluateTriggers must NOT have been called (roll short-circuits it).
    expect(evaluateTriggers).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: Roll does NOT fire when spot < roll_trigger_points
  // -------------------------------------------------------------------------

  it("does NOT return ROLL when |currentSpot - entrySpotProxy| < roll_trigger_points", async () => {
    // spotsFromEntry = |369 - 300| = 69 < 70 → no roll.
    const mockDb = makeMockDb(makeMockClient([]), 0);
    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: false });

    const result = await manager.evaluatePosition(
      mockPosition,
      295,  // currentStraddleValue
      369,  // currentSpot — 69 points above entry proxy (one below threshold)
      clock,
      mockTriggerConfig,
      mockDb,
      rollPersonality,
    );

    expect(result.shouldExit).toBe(false);
    // evaluateTriggers must have been called because we fell through to it.
    expect(evaluateTriggers).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Test 3: max_open_legs cap prevents roll — treats as Holder
  // -------------------------------------------------------------------------

  it("does NOT roll when openLegs >= max_open_legs / 2 (cap reached)", async () => {
    // With openLegs = 2 and max_open_legs = 4, the threshold is 4/2 = 2.
    // 2 >= 2 → cap is at-or-exceeded → treat as Holder.
    const mockDb = makeMockDb(makeMockClient([]), /* openLegs */ 2);
    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: false });

    // Spot has moved 80 points (well above roll_trigger_points = 70), so roll
    // would normally fire — but the cap prevents it.
    const result = await manager.evaluatePosition(
      mockPosition,
      310,   // currentStraddleValue
      380,   // currentSpot — 80 points above entry proxy
      clock,
      mockTriggerConfig,
      mockDb,
      rollPersonality,
    );

    expect(result.shouldExit).toBe(false);
    // evaluateTriggers must be called — we fell through to Holder behaviour.
    expect(evaluateTriggers).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Test 4: Boundary — roll fires at EXACTLY roll_trigger_points (>= not >)
  // -------------------------------------------------------------------------

  it("rolls at exactly roll_trigger_points (boundary — >= not >)", async () => {
    const mockDb = makeMockDb(makeMockClient([]), 0);

    // spotsFromEntry = |300 + 70 - 300| = 70 === roll_trigger_points → fires.
    const result = await manager.evaluatePosition(
      mockPosition,
      310,
      370, // exactly 70 above entry proxy 300
      clock,
      mockTriggerConfig,
      mockDb,
      rollPersonality,
    );

    expect(result.shouldExit).toBe(true);
    expect(result.exitReason).toBe("ROLL");
  });

  // -------------------------------------------------------------------------
  // Test 5: evaluateTriggers is called (and its result forwarded) when
  //         spot is within roll_trigger_points
  // -------------------------------------------------------------------------

  it("forwards evaluateTriggers result when spot is within roll threshold", async () => {
    const mockDb = makeMockDb(makeMockClient([]), 0);
    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: true, reason: "SL" });

    // spotsFromEntry = |360 - 300| = 60 < 70 → no roll → fall through to SL.
    const result = await manager.evaluatePosition(
      mockPosition,
      390, // straddle has risen above SL threshold
      360, // spot is within roll threshold
      clock,
      mockTriggerConfig,
      mockDb,
      rollPersonality,
    );

    expect(result.shouldExit).toBe(true);
    expect(result.exitReason).toBe("SL");
    expect(evaluateTriggers).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Test 6: default roll_trigger_points (70) when not set in params
  // -------------------------------------------------------------------------

  it("uses default roll_trigger_points of 70 when params does not set it", async () => {
    const personalityNoParams: PersonalityConfig = {
      ...rollPersonality,
      params: {}, // no roll_trigger_points — should default to 70
    };
    const mockDb = makeMockDb(makeMockClient([]), 0);

    // 69 points — should NOT roll.
    const resultBelow = await manager.evaluatePosition(
      mockPosition,
      310,
      369, // 69 points
      clock,
      mockTriggerConfig,
      mockDb,
      personalityNoParams,
    );
    expect(resultBelow.exitReason).not.toBe("ROLL");

    vi.clearAllMocks();
    vi.mocked(evaluateTriggers).mockReturnValue({ shouldExit: false });
    const mockDb2 = makeMockDb(makeMockClient([]), 0);

    // 70 points — SHOULD roll.
    const resultAtThreshold = await manager.evaluatePosition(
      mockPosition,
      310,
      370, // exactly 70 points
      clock,
      mockTriggerConfig,
      mockDb2,
      personalityNoParams,
    );
    expect(resultAtThreshold.shouldExit).toBe(true);
    expect(resultAtThreshold.exitReason).toBe("ROLL");
  });
});

// ---------------------------------------------------------------------------
// Tests: closePosition
// ---------------------------------------------------------------------------

describe("AdjusterManager.closePosition", () => {
  let manager: AdjusterManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AdjusterManager();
  });

  // -------------------------------------------------------------------------
  // Test 7: Non-ROLL exit delegates to executor.closeTrade, no transaction
  // -------------------------------------------------------------------------

  it("non-ROLL exit (SL_HIT): calls executor.closeTrade and does NOT start a transaction", async () => {
    // A minimal mock DB — connect() should NOT be called for non-ROLL exits.
    const mockClient = makeMockClient([]);
    const mockDb = makeMockDb(mockClient, 0);

    await manager.closePosition(
      mockPosition,
      390,    // currentStraddleValue
      "SL",   // exitReason — not a ROLL
      mockDb,
      clock,
      mockExecutor,
    );

    // closeTrade should have been called with the correct arguments.
    expect(mockExecutor.closeTrade).toHaveBeenCalledOnce();
    expect(mockExecutor.closeTrade).toHaveBeenCalledWith(
      mockPosition.id,
      "390", // String(390)
      "SL",
      clock,
    );

    // No transaction should have been started.
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it.each(["TSL", "TARGET", "EOD", "DAILY_LOSS", "EXIT_WINDOW"] as const)(
    "non-ROLL exit ('%s'): delegates to executor.closeTrade",
    async (reason) => {
      const mockClient = makeMockClient([]);
      const mockDb = makeMockDb(mockClient, 0);

      await manager.closePosition(mockPosition, 285, reason, mockDb, clock, mockExecutor);

      expect(mockExecutor.closeTrade).toHaveBeenCalledOnce();
      expect(mockExecutor.closeTrade).toHaveBeenCalledWith(
        mockPosition.id,
        "285",
        reason,
        clock,
      );
      expect(mockDb.connect).not.toHaveBeenCalled();
    },
  );

  // -------------------------------------------------------------------------
  // Test 8: ROLL close — transaction, parent_trade_id set on new trade
  // -------------------------------------------------------------------------

  it("ROLL: starts a transaction, closes old trade, inserts new trade with parent_trade_id", async () => {
    // Sequence of query responses for the mock client:
    //   [0] BEGIN         → { rows: [] }
    //   [1] SELECT (fetch parent row) → { rows: [parentData] }
    //   [2] UPDATE (close old trade)  → { rows: [] }
    //   [3] INSERT (new trade)        → { rows: [{ id: 'new-trade-id' }] }
    //   [4] COMMIT        → { rows: [] }
    const parentRow = {
      personality_id: "cccccccc-0000-0000-0000-000000000002",
      signal_id: "dddddddd-0000-0000-0000-000000000003",
      entry_ce_strike: "22000",
      lots: 1,
      lot_size: 50,
      straddle_at_entry: "300",
    };

    const queryResponses = [
      { rows: [] },                        // BEGIN
      { rows: [parentRow] },               // SELECT personality_id, signal_id, ...
      { rows: [] },                        // UPDATE (close)
      { rows: [{ id: "new-trade-uuid" }] }, // INSERT (new trade)
      { rows: [] },                        // COMMIT
    ];

    const mockClient = makeMockClient(queryResponses);
    const mockDb = makeMockDb(mockClient, 0);

    await manager.closePosition(
      mockPosition,
      310, // currentStraddleValue at roll time
      "ROLL",
      mockDb,
      clock,
      mockExecutor,
    );

    // connect() must have been called to get the transaction client.
    expect(mockDb.connect).toHaveBeenCalledOnce();

    // The client should have been called 5 times in order.
    const clientQuery = (mockClient as unknown as { query: ReturnType<typeof vi.fn> }).query;
    expect(clientQuery).toHaveBeenCalledTimes(5);

    // First call: BEGIN
    expect(clientQuery.mock.calls[0]?.[0]).toBe("BEGIN");

    // Second call: SELECT to fetch parent row fields
    const selectSql: string = clientQuery.mock.calls[1]?.[0];
    expect(selectSql).toContain("SELECT personality_id");
    expect(selectSql).toContain("FROM paper_trades");
    expect(clientQuery.mock.calls[1]?.[1]).toEqual([mockPosition.id]);

    // Third call: UPDATE to close the trade
    const updateSql: string = clientQuery.mock.calls[2]?.[0];
    expect(updateSql).toContain("UPDATE paper_trades");
    expect(updateSql).toContain("status");
    expect(updateSql).toContain("'closed'");
    // The WHERE clause should reference the position id
    const updateParams: unknown[] = clientQuery.mock.calls[2]?.[1];
    expect(updateParams).toContain(mockPosition.id);
    expect(updateParams).toContain("ROLL");

    // Fourth call: INSERT for the new trade
    const insertSql: string = clientQuery.mock.calls[3]?.[0];
    expect(insertSql).toContain("INSERT INTO paper_trades");
    expect(insertSql).toContain("parent_trade_id");
    const insertParams: unknown[] = clientQuery.mock.calls[3]?.[1];
    // parent_trade_id must be the closed trade's id (position.id)
    expect(insertParams).toContain(mockPosition.id);
    // personality_id should be inherited from parent
    expect(insertParams).toContain(parentRow.personality_id);
    // signal_id should be inherited from parent
    expect(insertParams).toContain(parentRow.signal_id);

    // Fifth call: COMMIT
    expect(clientQuery.mock.calls[4]?.[0]).toBe("COMMIT");

    // The transaction client should have been released.
    expect(mockClient.release).toHaveBeenCalledOnce();

    // executor.closeTrade must NOT have been called (we wrote the close inline).
    expect(mockExecutor.closeTrade).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 9: ROLL — ROLLBACK is called if INSERT fails
  // -------------------------------------------------------------------------

  it("ROLL: ROLLBACK is called when the INSERT throws", async () => {
    const parentRow = {
      personality_id: "cccccccc-0000-0000-0000-000000000002",
      signal_id: null,
      entry_ce_strike: "22000",
      lots: 1,
      lot_size: 50,
      straddle_at_entry: "300",
    };

    const insertError = new Error("DB insert failed");

    // Sequence:
    //   [0] BEGIN        → ok
    //   [1] SELECT       → parent row
    //   [2] UPDATE       → ok (close succeeds)
    //   [3] INSERT       → THROWS
    //   [4] ROLLBACK     → ok (called in catch block)
    const queryResponses = [
      { rows: [] },          // BEGIN
      { rows: [parentRow] }, // SELECT
      { rows: [] },          // UPDATE (close)
      insertError,           // INSERT → throws
      { rows: [] },          // ROLLBACK
    ];

    const mockClient = makeMockClient(queryResponses);
    const mockDb = makeMockDb(mockClient, 0);

    // closePosition should re-throw the INSERT error after rolling back.
    await expect(
      manager.closePosition(
        mockPosition,
        310,
        "ROLL",
        mockDb,
        clock,
        mockExecutor,
      ),
    ).rejects.toThrow("DB insert failed");

    // ROLLBACK must have been called.
    const clientQuery = (mockClient as unknown as { query: ReturnType<typeof vi.fn> }).query;
    const callArgs = clientQuery.mock.calls.map((c: unknown[]) => c[0]);
    expect(callArgs).toContain("ROLLBACK");
    // COMMIT must NOT have been called.
    expect(callArgs).not.toContain("COMMIT");

    // Client must still be released (finally block).
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Test 10: ROLL — ROLLBACK is called if parent trade is not found
  // -------------------------------------------------------------------------

  it("ROLL: throws and ROLLBACKs when parent trade row is not found in DB", async () => {
    // SELECT returns no rows — trade was already closed or deleted.
    const queryResponses = [
      { rows: [] }, // BEGIN
      { rows: [] }, // SELECT → empty (not found)
      { rows: [] }, // ROLLBACK
    ];

    const mockClient = makeMockClient(queryResponses);
    const mockDb = makeMockDb(mockClient, 0);

    await expect(
      manager.closePosition(mockPosition, 310, "ROLL", mockDb, clock, mockExecutor),
    ).rejects.toThrow(`trade not found for id=${mockPosition.id}`);

    const clientQuery = (mockClient as unknown as { query: ReturnType<typeof vi.fn> }).query;
    const callArgs = clientQuery.mock.calls.map((c: unknown[]) => c[0]);
    expect(callArgs).toContain("ROLLBACK");
    expect(callArgs).not.toContain("COMMIT");
    expect(mockClient.release).toHaveBeenCalledOnce();
  });
});
