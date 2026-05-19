/**
 * Unit tests for ScheduledSignalEmitter (and its FallbackSignalEmitter alias).
 *
 * All tests are self-contained: no real Redis connections are made.
 * Redis is replaced with a minimal in-memory stub that captures xadd calls.
 *
 * Time anchors (IST = UTC+5:30):
 *   IST 09:17 = UTC 03:47  — the default scheduled entry time
 *   IST 09:15 = UTC 03:45  — market open (just before scheduled entry)
 *   IST 10:00 = UTC 04:30  — well within market hours
 *   IST 08:00 = UTC 02:30  — pre-market (outside 09:15–15:30 window)
 *
 * We use 2026-05-19 (a Monday) as the base date and 2026-05-20 as "the next day".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FallbackSignalEmitter,
  type FallbackSignalConfig,
  ScheduledSignalEmitter,
} from "../scheduled-signal-emitter.js";
import type { Clock } from "../../utils/clock.js";

// ---------------------------------------------------------------------------
// Time anchors
// ---------------------------------------------------------------------------

/** 2026-05-19 09:17 IST = 2026-05-19T03:47:00.000Z */
const IST_0917_MAY19 = new Date("2026-05-19T03:47:00.000Z").getTime();

/** 2026-05-19 09:18 IST = 2026-05-19T03:48:00.000Z (one minute after scheduled) */
const IST_0918_MAY19 = new Date("2026-05-19T03:48:00.000Z").getTime();

/** 2026-05-19 10:00 IST = 2026-05-19T04:30:00.000Z (well within market hours) */
const IST_1000_MAY19 = new Date("2026-05-19T04:30:00.000Z").getTime();

/** 2026-05-19 08:00 IST = 2026-05-19T02:30:00.000Z (pre-market, outside window) */
const IST_0800_MAY19 = new Date("2026-05-19T02:30:00.000Z").getTime();

/** 2026-05-20 09:17 IST = 2026-05-20T03:47:00.000Z (next calendar day) */
const IST_0917_MAY20 = new Date("2026-05-20T03:47:00.000Z").getTime();

/** 2026-05-20 10:00 IST = 2026-05-20T04:30:00.000Z (next day, market hours) */
const IST_1000_MAY20 = new Date("2026-05-20T04:30:00.000Z").getTime();

// ---------------------------------------------------------------------------
// Stubs and helpers
// ---------------------------------------------------------------------------

/** Minimal Clock stub. */
function makeClock(nowMs: number): Clock {
  return {
    now: () => nowMs,
    today: () => "2026-05-19",
    toISTDate: () => "2026-05-19",
    toISTTime: () => "09:17:00",
  };
}

/**
 * Captures xadd calls so tests can assert on emitted signals without needing
 * a real Redis connection.
 *
 * xreadgroup is set up to return one batch of messages then block indefinitely
 * (by resolving a never-settling Promise), so the start() loop processes the
 * provided messages and then waits without busy-looping.
 *
 * xgroup silently succeeds (MKSTREAM/BUSYGROUP handling).
 * xack silently succeeds.
 */
interface CapturedXadd {
  stream: string;
  fields: Record<string, string>;
}

interface MockRedis {
  xaddCalls: CapturedXadd[];
  xreadgroupMessages: Array<{ id: string; fields: Record<string, string> }>;
  xgroup: (...args: unknown[]) => Promise<"OK">;
  xreadgroup: (...args: unknown[]) => Promise<unknown>;
  xack: (...args: unknown[]) => Promise<number>;
  xadd: (stream: string, id: string, ...flatFields: string[]) => Promise<string>;
}

function makeMockRedis(
  messages: Array<{ id: string; fields: Record<string, string> }> = [],
): MockRedis {
  const xaddCalls: CapturedXadd[] = [];
  let callCount = 0;

  return {
    xaddCalls,
    xreadgroupMessages: messages,
    xgroup: vi.fn().mockResolvedValue("OK"),
    xack: vi.fn().mockResolvedValue(1),
    xadd: vi.fn(async (stream: string, _id: string, ...flatFields: string[]) => {
      // Reconstruct the fields Record from the flat key/value array.
      const fields: Record<string, string> = {};
      for (let i = 0; i < flatFields.length - 1; i += 2) {
        fields[flatFields[i] as string] = flatFields[i + 1] as string;
      }
      xaddCalls.push({ stream, fields });
      return "1700000000000-0";
    }),
    xreadgroup: vi.fn(async (..._args: unknown[]) => {
      // First call: return the provided test messages.
      // Second call: simulate BLOCK returning null (no more messages).
      // Subsequent calls: block indefinitely so start() doesn't loop aggressively.
      callCount++;
      if (callCount === 1 && messages.length > 0) {
        // Wrap messages in the ioredis XREADGROUP response shape:
        //   [ [streamName, [ [id, [k, v, k, v, ...]], ...]] ]
        const formattedMessages = messages.map(({ id, fields }) => {
          const flat: string[] = [];
          for (const [k, v] of Object.entries(fields)) {
            flat.push(k, v);
          }
          return [id, flat];
        });
        return [["straddle.values", formattedMessages]];
      }
      if (callCount === 2) return null;
      // After the second call, block indefinitely (simulates BLOCK with no messages).
      return new Promise<never>(() => {});
    }),
  };
}

/**
 * Build a straddle.values stream message fields object for a given snapshot.
 * The `time` field is an epoch-ms string matching how straddle-calc.ts publishes.
 */
function makeSnapshotFields(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    time: String(IST_0917_MAY19),
    underlying: "NIFTY",
    spot: "23050.5",
    atmStrike: "23000",
    straddleValue: "450.25",
    vix: "18.5",
    ...overrides,
  };
}

/** Default config for most tests. */
const DEFAULT_CONFIG: FallbackSignalConfig = {
  scheduledEntryTime: "09:17",
  pullbackRetracePct: 3,
  pullbackLookbackCandles: 8,
  pullbackDedupWindowSecs: 600,
};

// ---------------------------------------------------------------------------
// Helper: drive the emitter through a list of snapshots without the Redis
// read loop. This bypasses start() and directly calls the private handler
// via a test-only approach (casting to any to access the private method).
// We prefer this over mocking the entire read loop because it:
//   - Tests the actual signal logic, not the Redis plumbing.
//   - Keeps tests fast and deterministic.
//   - Matches the pattern used in the other test files in this directory.
// ---------------------------------------------------------------------------

async function driveSnapshots(
  emitter: ScheduledSignalEmitter,
  snapshots: Array<Record<string, string>>,
): Promise<void> {
  for (const fields of snapshots) {
    // Access the private method via type assertion — necessary for whitebox unit
    // testing since the handler is the unit under test and not exposed publicly.
    await (emitter as unknown as { _handleSnapshot: (f: Record<string, string>) => Promise<void> })
      ._handleSnapshot(fields);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ScheduledSignalEmitter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Export alias
  // -------------------------------------------------------------------------

  it("FallbackSignalEmitter is the same class as ScheduledSignalEmitter", () => {
    expect(FallbackSignalEmitter).toBe(ScheduledSignalEmitter);
  });

  // -------------------------------------------------------------------------
  // Test 1: SCHEDULED signal fires at the configured time
  // -------------------------------------------------------------------------

  it("emits SCHEDULED signal on first snapshot at the configured time", async () => {
    const mockRedis = makeMockRedis();
    const clock = makeClock(IST_0917_MAY19);
    const emitter = new ScheduledSignalEmitter(
      mockRedis as unknown as import("ioredis").Redis,
      DEFAULT_CONFIG,
      clock,
    );

    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(IST_0917_MAY19) }),
    ]);

    expect(mockRedis.xaddCalls).toHaveLength(1);
    const call = mockRedis.xaddCalls[0];
    expect(call).toBeDefined();
    expect(call!.fields.signal_type).toBe("SCHEDULED");
    expect(call!.fields.underlying).toBe("NIFTY");
    expect(call!.fields.adjusted_probability).toBe("0.60");
    expect(call!.fields.confidence_tier).toBe("HIGH");
    expect(call!.fields.atm_strike).toBe("23000");
    expect(call!.stream).toBe("signals.generated");
    // signal_id should be a UUID
    expect(call!.fields.signal_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: SCHEDULED signal fires only once per calendar day per underlying
  // -------------------------------------------------------------------------

  it("emits SCHEDULED signal only once per calendar day per underlying", async () => {
    const mockRedis = makeMockRedis();
    const clock = makeClock(IST_0917_MAY19);
    const emitter = new ScheduledSignalEmitter(
      mockRedis as unknown as import("ioredis").Redis,
      DEFAULT_CONFIG,
      clock,
    );

    // Send two snapshots both at the configured time on the same day.
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(IST_0917_MAY19) }),
      makeSnapshotFields({ time: String(IST_0917_MAY19) }), // same time, same day
    ]);

    // Only the first should have triggered a SCHEDULED signal.
    const scheduledCalls = mockRedis.xaddCalls.filter(
      (c) => c.fields.signal_type === "SCHEDULED",
    );
    expect(scheduledCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 3: SCHEDULED signal does NOT fire outside market hours
  // -------------------------------------------------------------------------

  it("does NOT emit SCHEDULED signal outside market hours (08:00 IST)", async () => {
    const mockRedis = makeMockRedis();
    const clock = makeClock(IST_0800_MAY19);

    // Configure the entry time to be 08:00 so the time-match condition would
    // otherwise be met — but market hours gate should block it.
    const config: FallbackSignalConfig = { ...DEFAULT_CONFIG, scheduledEntryTime: "08:00" };
    const emitter = new ScheduledSignalEmitter(
      mockRedis as unknown as import("ioredis").Redis,
      config,
      clock,
    );

    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(IST_0800_MAY19) }),
    ]);

    expect(mockRedis.xaddCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 4: PULLBACK signal fires when straddle drops >= pullbackRetracePct%
  // -------------------------------------------------------------------------

  it("emits PULLBACK signal when straddle drops >= pullbackRetracePct% from peak", async () => {
    const mockRedis = makeMockRedis();
    const clock = makeClock(IST_0917_MAY19);
    const emitter = new ScheduledSignalEmitter(
      mockRedis as unknown as import("ioredis").Redis,
      DEFAULT_CONFIG,
      clock,
    );

    // Step 1: fire the SCHEDULED signal at 09:17 with straddle = 500.
    // This sets the peak to 500.
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(IST_0917_MAY19), straddleValue: "500" }),
    ]);

    // Step 2: straddle rises to 520 (new peak).
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(IST_0918_MAY19), straddleValue: "520" }),
    ]);

    // Step 3: straddle drops to 500 — drop is (520-500)/520 = 3.84% >= 3% threshold.
    // This should trigger a PULLBACK signal.
    const t3 = IST_0918_MAY19 + 15_000; // 15s later
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(t3), straddleValue: "500" }),
    ]);

    const pullbackCalls = mockRedis.xaddCalls.filter(
      (c) => c.fields.signal_type === "PULLBACK",
    );
    expect(pullbackCalls).toHaveLength(1);
    expect(pullbackCalls[0]!.fields.confidence_tier).toBe("MEDIUM");
    expect(pullbackCalls[0]!.fields.adjusted_probability).toBe("0.60");
  });

  // -------------------------------------------------------------------------
  // Test 5: PULLBACK signal does NOT fire when drop is below threshold
  // -------------------------------------------------------------------------

  it("does NOT emit PULLBACK signal when drop is below pullbackRetracePct%", async () => {
    const mockRedis = makeMockRedis();
    const clock = makeClock(IST_0917_MAY19);
    const emitter = new ScheduledSignalEmitter(
      mockRedis as unknown as import("ioredis").Redis,
      DEFAULT_CONFIG,
      clock,
    );

    // Scheduled signal fires with straddle = 500.
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(IST_0917_MAY19), straddleValue: "500" }),
    ]);

    // Straddle drops to 495 — drop is (500-495)/500 = 1% < 3% threshold.
    const t2 = IST_0917_MAY19 + 15_000;
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(t2), straddleValue: "495" }),
    ]);

    const pullbackCalls = mockRedis.xaddCalls.filter(
      (c) => c.fields.signal_type === "PULLBACK",
    );
    expect(pullbackCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 6: PULLBACK dedup window prevents second PULLBACK within 600s
  // -------------------------------------------------------------------------

  it("suppresses second PULLBACK within the dedup window (600s)", async () => {
    const mockRedis = makeMockRedis();
    const clock = makeClock(IST_0917_MAY19);
    const emitter = new ScheduledSignalEmitter(
      mockRedis as unknown as import("ioredis").Redis,
      DEFAULT_CONFIG,
      clock,
    );

    // Fire the SCHEDULED signal.
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(IST_0917_MAY19), straddleValue: "500" }),
    ]);

    // First PULLBACK: drop to 480 (4% drop from 500).
    const t2 = IST_0917_MAY19 + 15_000;
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(t2), straddleValue: "480" }),
    ]);

    // Recovery: straddle bounces to 490.
    const t3 = t2 + 15_000;
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(t3), straddleValue: "490" }),
    ]);

    // Second PULLBACK attempt: drop to 470 (= ~4.1% from 490 peak, within dedup window).
    // t4 is only 30s after t2 — well within the 600s dedup window.
    const t4 = t3 + 15_000;
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(t4), straddleValue: "470" }),
    ]);

    const pullbackCalls = mockRedis.xaddCalls.filter(
      (c) => c.fields.signal_type === "PULLBACK",
    );
    // Only the first PULLBACK should have been emitted.
    expect(pullbackCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 7: PULLBACK fires after dedup window expires
  // -------------------------------------------------------------------------

  it("emits a second PULLBACK after the dedup window expires", async () => {
    const mockRedis = makeMockRedis();
    const clock = makeClock(IST_0917_MAY19);
    const emitter = new ScheduledSignalEmitter(
      mockRedis as unknown as import("ioredis").Redis,
      DEFAULT_CONFIG,
      clock,
    );

    // Fire the SCHEDULED signal.
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(IST_0917_MAY19), straddleValue: "500" }),
    ]);

    // First PULLBACK: drop to 480.
    const t2 = IST_0917_MAY19 + 15_000;
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(t2), straddleValue: "480" }),
    ]);

    // Recovery + new peak at 510.
    const t3 = t2 + 15_000;
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(t3), straddleValue: "510" }),
    ]);

    // Second PULLBACK: 601 seconds after the first — dedup window expired.
    // Drop from 510 to 493 ≈ 3.3% drop > 3% threshold.
    const t4 = t2 + 601_000; // 601s after first pullback
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(t4), straddleValue: "493" }),
    ]);

    const pullbackCalls = mockRedis.xaddCalls.filter(
      (c) => c.fields.signal_type === "PULLBACK",
    );
    expect(pullbackCalls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Test 8: Peak tracking resets at midnight (date change)
  // -------------------------------------------------------------------------

  it("resets peak tracking at midnight (new IST date)", async () => {
    const mockRedis = makeMockRedis();
    const clock = makeClock(IST_0917_MAY19);
    const emitter = new ScheduledSignalEmitter(
      mockRedis as unknown as import("ioredis").Redis,
      DEFAULT_CONFIG,
      clock,
    );

    // Day 1: fire the SCHEDULED signal at 09:17.
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(IST_0917_MAY19), straddleValue: "500" }),
    ]);

    // Day 1: snapshot just before midnight — straddle at 490 (2% drop, no pullback).
    const day1End = IST_0917_MAY19 + 6 * 60 * 60_000; // ~15:17 IST
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(day1End), straddleValue: "490" }),
    ]);

    // Day 2: first snapshot after midnight — should reset state.
    // At 09:17 IST on May 20, the SCHEDULED signal should fire again (new day).
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(IST_0917_MAY20), straddleValue: "460" }),
    ]);

    const scheduledCalls = mockRedis.xaddCalls.filter(
      (c) => c.fields.signal_type === "SCHEDULED",
    );
    // One SCHEDULED per day = two total.
    expect(scheduledCalls).toHaveLength(2);

    // After the reset, the peak is set to the May 20 value (460), not carryover (490/500).
    // A drop to 445 from 460 = 3.26% >= 3% — should trigger PULLBACK on May 20.
    const t_may20_next = IST_0917_MAY20 + 15_000;
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(t_may20_next), straddleValue: "445" }),
    ]);

    const pullbackCalls = mockRedis.xaddCalls.filter(
      (c) => c.fields.signal_type === "PULLBACK",
    );
    // PULLBACK on May 20 with fresh peak tracking.
    expect(pullbackCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 9: straddleValue === 0 snapshots are skipped
  // -------------------------------------------------------------------------

  it("skips snapshots where straddleValue === 0 (simulator placeholder)", async () => {
    const mockRedis = makeMockRedis();
    const clock = makeClock(IST_0917_MAY19);
    const emitter = new ScheduledSignalEmitter(
      mockRedis as unknown as import("ioredis").Redis,
      DEFAULT_CONFIG,
      clock,
    );

    // Send a zero-value snapshot at the scheduled time — should be skipped.
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(IST_0917_MAY19), straddleValue: "0" }),
    ]);

    expect(mockRedis.xaddCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 10: PULLBACK does NOT fire before SCHEDULED signal fires
  // -------------------------------------------------------------------------

  it("does NOT emit PULLBACK before the daily SCHEDULED signal has fired", async () => {
    const mockRedis = makeMockRedis();
    const clock = makeClock(IST_1000_MAY19);

    // Configure scheduled entry at 12:00 (hasn't happened yet at 10:00).
    const config: FallbackSignalConfig = { ...DEFAULT_CONFIG, scheduledEntryTime: "12:00" };
    const emitter = new ScheduledSignalEmitter(
      mockRedis as unknown as import("ioredis").Redis,
      config,
      clock,
    );

    // Multiple snapshots at 10:00 with declining straddle — no peak tracking yet.
    await driveSnapshots(emitter, [
      makeSnapshotFields({ time: String(IST_1000_MAY19), straddleValue: "500" }),
      makeSnapshotFields({ time: String(IST_1000_MAY19 + 15_000), straddleValue: "460" }),
    ]);

    expect(mockRedis.xaddCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 11: integration — start() processes messages from mock Redis
  // -------------------------------------------------------------------------

  it("start() processes stream messages and emits signals via xadd", async () => {
    const snapshotFields = makeSnapshotFields({ time: String(IST_0917_MAY19) });
    const mockRedis = makeMockRedis([{ id: "1-0", fields: snapshotFields }]);
    const clock = makeClock(IST_0917_MAY19);
    const emitter = new ScheduledSignalEmitter(
      mockRedis as unknown as import("ioredis").Redis,
      DEFAULT_CONFIG,
      clock,
    );

    // start() runs the loop; it will block after the second xreadgroup call.
    // We race it against a short timeout to let the first message process.
    await Promise.race([
      emitter.start(),
      new Promise<void>((resolve) => setTimeout(resolve, 50)),
    ]);

    // xgroup CREATE should have been called (MKSTREAM).
    expect(mockRedis.xgroup).toHaveBeenCalledWith(
      "CREATE",
      "straddle.values",
      "fallback-signals",
      "$",
      "MKSTREAM",
    );

    // The SCHEDULED signal should have been emitted.
    const scheduledCalls = mockRedis.xaddCalls.filter(
      (c) => c.fields.signal_type === "SCHEDULED",
    );
    expect(scheduledCalls).toHaveLength(1);
  });
});
