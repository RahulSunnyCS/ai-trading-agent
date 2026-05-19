/**
 * Unit tests for personality-filter.ts
 *
 * All tests are pure: no database or Redis connections are made. The pg Pool
 * is mocked per-test with a minimal query() stub. Time-sensitive tests use
 * a fixed epoch that lands well within the default trading window.
 *
 * IST trading window defaults: ENTRY_START_TIME=09:20, ENTRY_CUTOFF_TIME=15:00.
 * UTC epoch 2026-05-19T05:00:00Z = 2026-05-19 10:30:00 IST — inside the window.
 */

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalityConfigM2 as PersonalityConfig } from "../../db/schema.js";
import {
  type DailyState,
  type StraddleSignalInput,
  checkComparisonIntegrity,
  fetchDailyState,
  runPersonalityFilter,
} from "../personality-filter.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * 2026-05-19 10:30:00 IST = 2026-05-19T05:00:00.000Z in UTC.
 * This is a Monday inside the default trading window (09:20–15:00 IST).
 */
const IST_1030_MAY19 = new Date("2026-05-19T05:00:00.000Z").getTime();

/**
 * 2026-05-19 08:00:00 IST = 2026-05-19T02:30:00.000Z in UTC.
 * Outside the entry window (before 09:20).
 */
const IST_0800_MAY19 = new Date("2026-05-19T02:30:00.000Z").getTime();

/**
 * 2026-05-19 15:30:00 IST = 2026-05-19T10:00:00.000Z in UTC.
 * Outside the entry window (after 15:00).
 */
const IST_1530_MAY19 = new Date("2026-05-19T10:00:00.000Z").getTime();

/** A valid MOMENTUM_EXHAUSTION signal that passes all stages by default. */
function makeSignal(overrides: Partial<StraddleSignalInput> = {}): StraddleSignalInput {
  return {
    signalType: "MOMENTUM_EXHAUSTION",
    signalId: "sig-001",
    underlying: "NIFTY",
    atmStrike: 22000,
    spot: 22000,
    straddleValue: 200,
    vix: 15,
    adjustedProbability: 0.75,
    confidenceTier: "HIGH",
    signalTimeMs: IST_1030_MAY19,
    ...overrides,
  };
}

/** A SCHEDULED signal for Clockwork-style tests. */
function makeScheduledSignal(overrides: Partial<StraddleSignalInput> = {}): StraddleSignalInput {
  return {
    signalType: "SCHEDULED",
    signalId: "sig-clockwork",
    underlying: "NIFTY",
    atmStrike: 22000,
    spot: 22000,
    straddleValue: 200,
    vix: 15,
    adjustedProbability: 0,   // Clockwork has no min_probability, so 0 passes
    confidenceTier: "LOW",
    signalTimeMs: IST_1030_MAY19,
    ...overrides,
  };
}

/**
 * Builds a minimal PersonalityConfig.
 * Only the fields exercised by the filter are needed; the rest get safe defaults.
 */
function makePersonality(overrides: Partial<PersonalityConfig> = {}): PersonalityConfig {
  return {
    id: "pers-001",
    name: "precision",
    displayName: "Precision",
    groupType: "reference",
    entryType: "momentum_exhaustion",
    managementStyle: "hold",
    isFrozen: false,
    isActive: true,
    phase: 1,
    params: {
      min_probability: 0.70,
      max_daily_trades: 2,
      max_daily_loss: 8000,
      vix_max: 25,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Daily state with all counts at zero — passes Stage 2 by default. */
const emptyDailyState: DailyState = {
  tradeCount: 0,
  netPnl: "0",
  openPositions: 0,
};

// ---------------------------------------------------------------------------
// Env-var cleanup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Clear any env overrides before each test to prevent cross-test contamination
  for (const key of ["BLOCKED_DATES", "ENTRY_START_TIME", "ENTRY_CUTOFF_TIME"]) {
    Reflect.deleteProperty(process.env, key);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Stage 1 — Hard filters
// ---------------------------------------------------------------------------

describe("Stage 1 — signal type matching", () => {
  it("rejects a fixed_time personality when it receives a MOMENTUM_EXHAUSTION signal", () => {
    const personality = makePersonality({
      name: "clockwork",
      entryType: "fixed_time",
      params: { max_daily_trades: 1, max_daily_loss: 5000 },
    });

    const result = runPersonalityFilter(
      makeSignal({ signalType: "MOMENTUM_EXHAUSTION" }),
      personality,
      emptyDailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(false);
    expect(result.stage).toBe(1);
    expect(result.reason).toMatch(/ENTRY_TYPE_MISMATCH/);
    expect(result.reason).toMatch(/fixed_time/);
  });

  it("rejects a momentum_exhaustion personality when it receives a SCHEDULED signal", () => {
    const personality = makePersonality({ entryType: "momentum_exhaustion" });

    const result = runPersonalityFilter(
      makeScheduledSignal(),
      personality,
      emptyDailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(false);
    expect(result.stage).toBe(1);
    expect(result.reason).toMatch(/ENTRY_TYPE_MISMATCH/);
    expect(result.reason).toMatch(/momentum_exhaustion/);
  });

  it("rejects an inactive personality regardless of signal type", () => {
    const personality = makePersonality({ isActive: false });

    const result = runPersonalityFilter(
      makeSignal(),
      personality,
      emptyDailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(false);
    expect(result.stage).toBe(1);
    expect(result.reason).toBe("PERSONALITY_INACTIVE");
  });

  it("rejects when the current IST time is before the entry window start", () => {
    const personality = makePersonality();

    // IST 08:00 — before default 09:20 start
    const result = runPersonalityFilter(
      makeSignal({ signalTimeMs: IST_0800_MAY19 }),
      personality,
      emptyDailyState,
      IST_0800_MAY19, // nowMs is before window
    );

    expect(result.pass).toBe(false);
    expect(result.stage).toBe(1);
    expect(result.reason).toMatch(/OUTSIDE_TRADING_HOURS/);
  });

  it("rejects when the current IST time is after the entry window cutoff", () => {
    const personality = makePersonality();

    // IST 15:30 — after default 15:00 cutoff
    const result = runPersonalityFilter(
      makeSignal({ signalTimeMs: IST_1530_MAY19 }),
      personality,
      emptyDailyState,
      IST_1530_MAY19, // nowMs is after window
    );

    expect(result.pass).toBe(false);
    expect(result.stage).toBe(1);
    expect(result.reason).toMatch(/OUTSIDE_TRADING_HOURS/);
  });

  it("rejects when today is in the BLOCKED_DATES list", () => {
    // 2026-05-19 is blocked
    process.env["BLOCKED_DATES"] = JSON.stringify(["2026-05-19"]);
    const personality = makePersonality();

    const result = runPersonalityFilter(
      makeSignal(),
      personality,
      emptyDailyState,
      IST_1030_MAY19, // nowMs resolves to 2026-05-19 IST
    );

    expect(result.pass).toBe(false);
    expect(result.stage).toBe(1);
    expect(result.reason).toMatch(/BLOCKED_DATE/);
    expect(result.reason).toMatch(/2026-05-19/);
  });

  it("passes Stage 1 when the date is not in BLOCKED_DATES", () => {
    process.env["BLOCKED_DATES"] = JSON.stringify(["2026-01-15"]); // different date

    const personality = makePersonality();
    const result = runPersonalityFilter(
      makeSignal(),
      personality,
      emptyDailyState,
      IST_1030_MAY19,
    );

    // Should not fail at stage 1 for a non-blocked date (may pass all stages)
    if (!result.pass) {
      // Only acceptable failure is from a stage > 1
      expect(result.stage).toBeGreaterThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — State checks
// ---------------------------------------------------------------------------

describe("Stage 2 — daily state limits", () => {
  it("rejects when tradeCount meets max_daily_trades", () => {
    const personality = makePersonality({
      params: {
        min_probability: 0.70,
        max_daily_trades: 2,
        max_daily_loss: 8000,
      },
    });

    const dailyState: DailyState = { tradeCount: 2, netPnl: "0", openPositions: 0 };

    const result = runPersonalityFilter(
      makeSignal(),
      personality,
      dailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(false);
    expect(result.stage).toBe(2);
    expect(result.reason).toBe("MAX_DAILY_TRADES_REACHED");
  });

  it("rejects when net P&L has hit the daily loss limit", () => {
    const personality = makePersonality({
      params: {
        min_probability: 0.70,
        max_daily_trades: 2,
        max_daily_loss: 8000,
      },
    });

    // netPnl = '-8000' equals exactly -max_daily_loss — the condition is <=
    const dailyState: DailyState = { tradeCount: 0, netPnl: "-8000", openPositions: 0 };

    const result = runPersonalityFilter(
      makeSignal(),
      personality,
      dailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(false);
    expect(result.stage).toBe(2);
    expect(result.reason).toBe("DAILY_LOSS_LIMIT_REACHED");
  });

  it("rejects when open position count meets the half-of-max_open_legs threshold", () => {
    // max_open_legs = 4 → max open straddles = 2 → reject when openPositions >= 2
    const personality = makePersonality({
      params: {
        min_probability: 0.70,
        max_daily_trades: 10,
        max_daily_loss: 20000,
        max_open_legs: 4,
      },
    });

    const dailyState: DailyState = { tradeCount: 0, netPnl: "0", openPositions: 2 };

    const result = runPersonalityFilter(
      makeSignal(),
      personality,
      dailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(false);
    expect(result.stage).toBe(2);
    expect(result.reason).toBe("MAX_OPEN_POSITIONS_REACHED");
  });

  it("passes Stage 2 when no limits are exceeded", () => {
    const personality = makePersonality({
      params: {
        min_probability: 0.70,
        max_daily_trades: 2,
        max_daily_loss: 8000,
        vix_max: 25,
      },
    });

    const dailyState: DailyState = { tradeCount: 1, netPnl: "-100", openPositions: 0 };

    const result = runPersonalityFilter(
      makeSignal(),
      personality,
      dailyState,
      IST_1030_MAY19,
    );

    // If it passes Stage 2 it should reach Stage 3 or beyond
    if (!result.pass) {
      expect(result.stage).toBeGreaterThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 3 — Context checks (VIX)
// ---------------------------------------------------------------------------

describe("Stage 3 — VIX ceiling", () => {
  it("rejects when VIX exceeds vix_max", () => {
    const personality = makePersonality({
      params: { min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 8000, vix_max: 25 },
    });

    const result = runPersonalityFilter(
      makeSignal({ vix: 30 }),   // 30 > 25
      personality,
      emptyDailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(false);
    expect(result.stage).toBe(3);
    expect(result.reason).toBe("VIX_TOO_HIGH");
  });

  it("passes Stage 3 when VIX is null even if vix_max is set (missing feed = allow)", () => {
    const personality = makePersonality({
      params: { min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 8000, vix_max: 25 },
    });

    // VIX feed unavailable — should not block entry
    const result = runPersonalityFilter(
      makeSignal({ vix: null }),
      personality,
      emptyDailyState,
      IST_1030_MAY19,
    );

    // Stage 3 must NOT reject; if a rejection occurs it must be from stage 4+
    if (!result.pass) {
      expect(result.stage).toBeGreaterThanOrEqual(4);
    }
  });

  it("passes Stage 3 when VIX equals vix_max (boundary: strict > not >=)", () => {
    const personality = makePersonality({
      params: { min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 8000, vix_max: 25 },
    });

    // VIX == vix_max → should NOT reject (condition is strictly >)
    const result = runPersonalityFilter(
      makeSignal({ vix: 25 }),
      personality,
      emptyDailyState,
      IST_1030_MAY19,
    );

    if (!result.pass) {
      expect(result.stage).toBeGreaterThanOrEqual(4);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 4 — Signal quality (probability gate)
// ---------------------------------------------------------------------------

describe("Stage 4 — probability threshold", () => {
  it("rejects when adjustedProbability is below min_probability", () => {
    const personality = makePersonality({
      params: {
        min_probability: 0.70,
        max_daily_trades: 2,
        max_daily_loss: 8000,
        vix_max: 30, // permissive so stage 3 passes
      },
    });

    const result = runPersonalityFilter(
      makeSignal({ adjustedProbability: 0.60 }), // 0.60 < 0.70
      personality,
      emptyDailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(false);
    expect(result.stage).toBe(4);
    expect(result.reason).toBe("PROBABILITY_BELOW_THRESHOLD");
  });

  it("passes Stage 4 when adjustedProbability equals min_probability (boundary: >= check)", () => {
    const personality = makePersonality({
      params: { min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 8000, vix_max: 30 },
    });

    const result = runPersonalityFilter(
      makeSignal({ adjustedProbability: 0.70 }), // exactly at threshold
      personality,
      emptyDailyState,
      IST_1030_MAY19,
    );

    // Should pass Stage 4; any failure must be stage 5
    if (!result.pass) {
      expect(result.stage).toBe(5);
    }
  });

  it("skips the probability check for SCHEDULED signals (Clockwork is not probability-gated)", () => {
    const clockwork = makePersonality({
      name: "clockwork",
      entryType: "fixed_time",
      params: {
        max_daily_trades: 1,
        max_daily_loss: 5000,
        // no min_probability — Clockwork doesn't have one
      },
    });

    const result = runPersonalityFilter(
      makeScheduledSignal({ adjustedProbability: 0 }), // would fail if checked
      clockwork,
      emptyDailyState,
      IST_1030_MAY19,
    );

    // Probability check is skipped for SCHEDULED — should pass all stages
    expect(result.pass).toBe(true);
    expect(result.stage).toBe(6);
    expect(result.reason).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Stage 5 — Profit gate
// ---------------------------------------------------------------------------

describe("Stage 5 — profit gate", () => {
  it("blocks entry when profit gate is active and today P&L meets the gate amount", () => {
    const personality = makePersonality({
      params: {
        min_probability: 0.70,
        max_daily_trades: 10,
        max_daily_loss: 20000,
        vix_max: 30,
        require_profit_gate: true,
        profit_gate_amount: 5000,
      },
    });

    // netPnl == profit_gate_amount → gate fires
    const dailyState: DailyState = { tradeCount: 1, netPnl: "5000", openPositions: 0 };

    const result = runPersonalityFilter(
      makeSignal(),
      personality,
      dailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(false);
    expect(result.stage).toBe(5);
    expect(result.reason).toBe("PROFIT_GATE_REACHED");
  });

  it("allows entry when profit gate is active but P&L is below the gate amount", () => {
    const personality = makePersonality({
      params: {
        min_probability: 0.70,
        max_daily_trades: 10,
        max_daily_loss: 20000,
        vix_max: 30,
        require_profit_gate: true,
        profit_gate_amount: 5000,
      },
    });

    // netPnl below gate amount — should pass
    const dailyState: DailyState = { tradeCount: 1, netPnl: "2500", openPositions: 0 };

    const result = runPersonalityFilter(
      makeSignal(),
      personality,
      dailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(true);
    expect(result.stage).toBe(6);
    expect(result.reason).toBe("PASS");
  });

  it("passes Stage 5 when require_profit_gate is absent (gate disabled by default)", () => {
    // Precision does not have require_profit_gate — gate must never fire
    const personality = makePersonality({
      params: {
        min_probability: 0.70,
        max_daily_trades: 2,
        max_daily_loss: 8000,
        vix_max: 30,
        // no require_profit_gate
      },
    });

    const dailyState: DailyState = { tradeCount: 0, netPnl: "50000", openPositions: 0 };

    const result = runPersonalityFilter(
      makeSignal(),
      personality,
      dailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(true);
    expect(result.stage).toBe(6);
    expect(result.reason).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Happy path — all stages pass
// ---------------------------------------------------------------------------

describe("Happy path — all stages pass", () => {
  it("all stages pass for a valid Clockwork SCHEDULED signal", () => {
    const clockwork = makePersonality({
      name: "clockwork",
      entryType: "fixed_time",
      isFrozen: true,
      params: { max_daily_trades: 1, max_daily_loss: 5000 },
    });

    const dailyState: DailyState = { tradeCount: 0, netPnl: "0", openPositions: 0 };

    const result = runPersonalityFilter(
      makeScheduledSignal(),
      clockwork,
      dailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(true);
    expect(result.stage).toBe(6);
    expect(result.reason).toBe("PASS");
  });

  it("all stages pass for a valid Precision MOMENTUM_EXHAUSTION signal above threshold", () => {
    const precision = makePersonality({
      name: "precision",
      entryType: "momentum_exhaustion",
      params: {
        min_probability: 0.70,
        max_daily_trades: 2,
        max_daily_loss: 8000,
        entry_delay_secs: 120,
        vix_max: 25,
      },
    });

    const dailyState: DailyState = { tradeCount: 0, netPnl: "0", openPositions: 0 };

    const result = runPersonalityFilter(
      makeSignal({ adjustedProbability: 0.80, vix: 15 }),
      precision,
      dailyState,
      IST_1030_MAY19,
    );

    expect(result.pass).toBe(true);
    expect(result.stage).toBe(6);
    expect(result.reason).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// checkComparisonIntegrity
// ---------------------------------------------------------------------------

describe("checkComparisonIntegrity", () => {
  it("returns invalid and names the outlier when drift exceeds 8pp", () => {
    const personalities: PersonalityConfig[] = [
      makePersonality({
        name: "precision",
        params: { min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 8000 },
      }),
      makePersonality({
        id: "pers-002",
        name: "adjuster",
        params: { min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 12000 },
      }),
      // Reducer drifted to 0.55 — 15pp below the others
      makePersonality({
        id: "pers-003",
        name: "reducer",
        params: { min_probability: 0.55, max_daily_trades: 4, max_daily_loss: 10000 },
      }),
    ];

    const result = checkComparisonIntegrity(personalities);

    expect(result.valid).toBe(false);
    expect(result.offender).toBe("reducer");
    expect(result.message).toBeDefined();
    expect(result.message).toMatch(/reducer/);
  });

  it("returns valid when all active momentum personalities are within 8pp", () => {
    const personalities: PersonalityConfig[] = [
      makePersonality({
        name: "precision",
        params: { min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 8000 },
      }),
      makePersonality({
        id: "pers-002",
        name: "adjuster",
        params: { min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 12000 },
      }),
      makePersonality({
        id: "pers-003",
        name: "reducer",
        params: { min_probability: 0.68, max_daily_trades: 4, max_daily_loss: 10000 },
      }),
    ];

    const result = checkComparisonIntegrity(personalities);

    expect(result.valid).toBe(true);
    expect(result.offender).toBeUndefined();
    expect(result.message).toBeUndefined();
  });

  it("returns valid and no offender when spread is exactly 8pp (boundary)", () => {
    const personalities: PersonalityConfig[] = [
      makePersonality({
        name: "precision",
        params: { min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 8000 },
      }),
      makePersonality({
        id: "pers-002",
        name: "reducer",
        params: { min_probability: 0.62, max_daily_trades: 4, max_daily_loss: 10000 },
      }),
    ];

    // spread = 0.70 - 0.62 = 0.08 (exactly 8pp) → valid
    const result = checkComparisonIntegrity(personalities);

    expect(result.valid).toBe(true);
  });

  it("excludes inactive personalities from the comparison", () => {
    const personalities: PersonalityConfig[] = [
      makePersonality({
        name: "precision",
        params: { min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 8000 },
      }),
      makePersonality({
        id: "pers-002",
        name: "adjuster",
        params: { min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 12000 },
      }),
      // Reducer is inactive with a badly-drifted threshold
      makePersonality({
        id: "pers-003",
        name: "reducer",
        isActive: false,   // inactive — must be excluded
        params: { min_probability: 0.20, max_daily_trades: 4, max_daily_loss: 10000 },
      }),
    ];

    // With reducer excluded, only precision and adjuster are compared — both 0.70 → valid
    const result = checkComparisonIntegrity(personalities);
    expect(result.valid).toBe(true);
  });

  it("returns valid when fewer than 2 active momentum personalities exist", () => {
    const personalities: PersonalityConfig[] = [
      makePersonality({
        name: "precision",
        params: { min_probability: 0.70, max_daily_trades: 2, max_daily_loss: 8000 },
      }),
    ];

    const result = checkComparisonIntegrity(personalities);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchDailyState — mocked DB pool
// ---------------------------------------------------------------------------

describe("fetchDailyState", () => {
  it("returns correct tradeCount, netPnl, and openPositions from mocked pool", async () => {
    // Build a mock pg Pool whose query() returns controlled rows based on SQL content.
    // We inspect the SQL string to distinguish the two queries:
    //   - query for 'closed' → returns trade count and net P&L
    //   - query for 'open' → returns open position count
    const mockQuery = vi.fn((sql: string) => {
      if (typeof sql === "string" && sql.includes("status = 'closed'")) {
        return Promise.resolve({
          rows: [{ today_trade_count: "3", today_net_pnl: "2500.50" }],
          rowCount: 1,
        });
      }
      // The 'open' query
      return Promise.resolve({
        rows: [{ open_legs: "1" }],
        rowCount: 1,
      });
    });

    const mockDb = { query: mockQuery } as unknown as Pool;

    const result = await fetchDailyState(mockDb, "pers-001", "2026-05-19");

    expect(result.tradeCount).toBe(3);
    expect(result.netPnl).toBe("2500.50");
    expect(result.openPositions).toBe(1);

    // Both queries must have been called
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("returns zero counts when no trades exist (COALESCE handles NULL)", async () => {
    // pg will return the COALESCE default '0' string when SUM is over zero rows.
    const mockQuery = vi.fn((sql: string) => {
      if (typeof sql === "string" && sql.includes("status = 'closed'")) {
        return Promise.resolve({
          rows: [{ today_trade_count: "0", today_net_pnl: "0" }],
          rowCount: 1,
        });
      }
      return Promise.resolve({
        rows: [{ open_legs: "0" }],
        rowCount: 1,
      });
    });

    const mockDb = { query: mockQuery } as unknown as Pool;

    const result = await fetchDailyState(mockDb, "pers-001", "2026-05-19");

    expect(result.tradeCount).toBe(0);
    expect(result.netPnl).toBe("0");
    expect(result.openPositions).toBe(0);
  });

  it("passes personalityId and todayIST as parameterised query arguments", async () => {
    const mockQuery = vi.fn((_sql: string, _params?: unknown[]) =>
      Promise.resolve({ rows: [{ today_trade_count: "0", today_net_pnl: "0" }], rowCount: 1 }),
    );

    const mockDb = { query: mockQuery } as unknown as Pool;

    await fetchDailyState(mockDb, "personality-uuid-123", "2026-05-19");

    // Both calls must include the personality ID as the first parameter.
    // Cast to unknown[] because noUncheckedIndexedAccess makes the tuple element
    // type indeterminate — the actual runtime array contains the params we passed.
    const call0Params = mockQuery.mock.calls[0]?.[1] as unknown[];
    const call1Params = mockQuery.mock.calls[1]?.[1] as unknown[];

    expect(call0Params).toContain("personality-uuid-123");
    expect(call1Params).toContain("personality-uuid-123");

    // The closed-trade query must include the date as the second parameter
    expect(call0Params).toContain("2026-05-19");
  });
});
