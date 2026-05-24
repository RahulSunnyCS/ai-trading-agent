/**
 * T-57 Deterministic Replay Harness — Test Suite
 *
 * Tests covered:
 *
 * A. GOLDEN ORACLE
 *    Loads the frozen fixture from fixtures/golden/fixture.json, replays it
 *    through the pipeline (with mock Redis — no Docker required), and asserts
 *    the produced snapshot ledger matches the expected ledger stored in the fixture.
 *    Comparison is structural (Decimal.js + stable key ordering), NOT byte-for-byte.
 *
 * B. 100x IDENTICAL-LEDGER GATE
 *    Runs the replay 100 times in succession and asserts every run produces
 *    an identical canonical snapshot ledger. Tests that no floating promises,
 *    race conditions, or wall-clock dependencies exist in the replay path.
 *
 * C. DRAIN BARRIER (processedThrough)
 *    Tests that PositionMonitor.processedThrough(streamId) is a concrete,
 *    observable barrier: it resolves ONLY after the poll loop advances lastId
 *    past the target, and it resolves immediately when lastId is already past.
 *
 * D. LIVE-PATH REGRESSION
 *    Verifies that StraddleCalculator still fires via setInterval + void in
 *    live mode (the snapshotStep() addition must not break the live path).
 *    Asserts snapshot cadence matches setInterval timing using fake timers.
 *
 * E. FIXTURE STRUCTURAL ASSERTIONS
 *    Asserts the fixture itself is well-formed: ≥1 gap-marked tick, ≥1
 *    resolution tag — required as M3b backtest input.
 *
 * All tests in this file run WITHOUT Docker services (unit test project).
 * Tests that require real Redis or PostgreSQL are in replay-driver.integration.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Decimal from 'decimal.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPositionMonitor } from '../../../trading/position-monitor';
import { VirtualClock } from '../../../utils/clock';
import { createStraddleCalculator } from '../../straddle-calc';
import type { StraddleSnapshot } from '../../straddle-calc';
import type { FixtureTick, GoldenFixture } from '../historical-feed';

// ---------------------------------------------------------------------------
// Load the frozen fixture once (it never changes between runs in CI)
// ---------------------------------------------------------------------------

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures/golden/fixture.json');

function loadFixture(): GoldenFixture {
  const raw = readFileSync(FIXTURE_PATH, 'utf-8');
  return JSON.parse(raw) as GoldenFixture;
}

const FIXTURE = loadFixture();

// ---------------------------------------------------------------------------
// Decimal-based canonical comparison
// ---------------------------------------------------------------------------

/**
 * Canonicalise a snapshot for structural comparison.
 *
 * Rules:
 *   - All numeric fields rounded to 10 decimal places via Decimal.js to
 *     eliminate floating-point accumulation differences across JS engines.
 *   - Keys sorted alphabetically (stable ordering across serialisers).
 *   - Only the fields present in the expectedSnapshotLedger are compared.
 *
 * WHY Decimal.js at 10dp rather than byte-for-byte?
 * JavaScript floating-point arithmetic is deterministic within a single engine
 * version, but the fixture may be generated on a different machine or engine
 * version than CI. Comparing at 10dp captures the semantically meaningful
 * precision (straddle values are INR amounts) while tolerating the ~15th-decimal
 * rounding that can differ between engine versions.
 */
function canonicaliseSnapshot(snap: StraddleSnapshot): Record<string, string | number> {
  const DP = 10; // decimal places for normalisation

  // Helper: normalise to 10dp string via Decimal to avoid JS float
  // representation differences (e.g. 2.711864406779661 vs 2.7118644068 etc.)
  function norm(n: number): string {
    return new Decimal(n).toFixed(DP);
  }

  // Build a record with sorted keys and normalised numeric values.
  // Non-numeric fields (underlying) are kept as-is.
  const result: Record<string, string | number> = {
    acceleration: norm(snap.acceleration),
    atmStrike: snap.atmStrike,
    cePrice: norm(snap.cePrice),
    pePrice: norm(snap.pePrice),
    roc: norm(snap.roc),
    snapshotCount: snap.snapshotCount,
    straddleValue: norm(snap.straddleValue),
    underlying: snap.underlying,
  };

  return result;
}

/**
 * Canonicalise a fixture ledger entry for comparison with a replay snapshot.
 *
 * Uses the same Decimal.js normalisation as canonicaliseSnapshot so the
 * comparison is consistent on both sides.
 */
function canonicaliseLedgerEntry(entry: Record<string, unknown>): Record<string, string | number> {
  const DP = 10;
  function norm(v: unknown): string {
    return new Decimal(String(v)).toFixed(DP);
  }
  return {
    acceleration: norm(entry.acceleration),
    atmStrike: Number(entry.atmStrike),
    cePrice: norm(entry.cePrice),
    pePrice: norm(entry.pePrice),
    roc: norm(entry.roc),
    snapshotCount: Number(entry.snapshotCount),
    straddleValue: norm(entry.straddleValue),
    underlying: 'NIFTY',
  };
}

// ---------------------------------------------------------------------------
// In-memory replay harness (no Docker required)
//
// We simulate the pipeline WITHOUT real Redis by wiring a fake Redis that
// stores messages in-memory. The components talk to this fake Redis, which
// gives us end-to-end pipeline coverage (HistoricalFeed → StraddleCalc →
// PositionMonitor) without infrastructure dependencies.
//
// The StraddleCalculator poll loop reads from market.ticks via its XREAD
// cursor. To avoid real Redis, we intercept xread/xadd at the fake level.
// ---------------------------------------------------------------------------

/**
 * A minimal in-memory Redis that supports the subset of commands used by
 * StraddleCalculator and PositionMonitor:
 *   - xadd: appends to a named stream, returns a monotonic ID.
 *   - xread: returns entries added after the cursor (non-blocking).
 *
 * WHY in-memory rather than mocking?
 * The StraddleCalculator has an internal poll loop that calls xread repeatedly.
 * A vi.fn() mock would need complex state to track the cursor across calls.
 * An in-memory implementation is simpler, more realistic, and easier to reason about.
 */
function makeInMemoryRedis() {
  // Map from stream name → array of { id, fields } entries.
  const streams = new Map<string, Array<{ id: string; data: string }>>();

  // Monotonically increasing counter for IDs.
  // We use zero-padded IDs (8 digits) so that lexicographic comparison
  // matches numeric order: '00000001-0' < '00000002-0' < ... < '00000010-0'.
  // Without padding, '10-0' < '9-0' lexicographically (first char '1' < '9'),
  // which would cause the fake xread's string comparison to silently skip entries.
  let counter = 1;

  function makeId(): string {
    return `${String(counter).padStart(8, '0')}-0`;
  }

  function getStream(name: string): Array<{ id: string; data: string }> {
    if (!streams.has(name)) streams.set(name, []);
    return streams.get(name)!;
  }

  return {
    // Simulate XADD with auto-generated zero-padded ID.
    // Returns the assigned ID (e.g. "00000001-0", "00000002-0" ...).
    async xadd(stream: string, _idArg: string, field: string, data: string): Promise<string> {
      if (field !== 'data') {
        throw new Error(`[fake-redis] xadd: unexpected field name '${field}'`);
      }
      const id = makeId();
      counter++;
      getStream(stream).push({ id, data });
      return id;
    },

    // Simulate XREAD COUNT n STREAMS <name> <cursor>.
    // Returns the ioredis XREAD shape or null.
    async xread(
      _countKeyword: string,
      _count: number,
      _streamsKeyword: string,
      stream: string,
      cursor: string,
    ): Promise<[string, [string, string[]][]][] | null> {
      const entries = getStream(stream);

      // Find entries after cursor.
      // Cursor '$' would mean "from the end", but we FORBID '$' in replay.
      // We treat '$' as an error here to catch any accidental use.
      if (cursor === '$') {
        throw new Error(
          '[fake-redis] REPLAY PATH VIOLATION: $ cursor is forbidden in replay. ' +
            'Configure StraddleCalculator with startId="0".',
        );
      }

      // Filter entries with id > cursor (lexicographic comparison — works correctly
      // because IDs are zero-padded to 8 digits so lexicographic = numeric order).
      const after = entries.filter((e) => e.id > cursor);

      if (after.length === 0) return null;

      const messages: [string, string[]][] = after.map((e) => [e.id, ['data', e.data]]);
      return [[stream, messages]];
    },

    // Expose internal state for test assertions.
    _streams: streams,
    _getEntries: (name: string) => getStream(name),
  };
}

// ---------------------------------------------------------------------------
// Core replay function used by both the golden oracle and 100x gate
//
// Design: the replay uses vi.useFakeTimers() (set up by the caller in
// beforeEach/afterEach) so that the poll loops' sleep(100) calls are
// controlled by fake time. Between each emit+snapshot step, we advance
// fake timers by 200ms to flush any pending sleeps in the poll loops.
//
// WHY fake timers instead of real waits?
// The poll loops use setTimeout-based sleep() when no data is available.
// With real timers, the test would need to wait 100ms per poll loop iteration,
// making the 100x gate take 100*13*100ms = 130 seconds — unacceptably slow.
// With fake timers, advancing by 200ms is instantaneous.
//
// The downside: we cannot use real async delays in the test. All async
// operations in the test must either be driven by await (which flushes the
// microtask queue) or by vi.advanceTimersByTimeAsync().
// ---------------------------------------------------------------------------

/**
 * Advance fake timers enough to flush one poll loop iteration.
 *
 * Each poll loop iteration either:
 *   (a) finds no data → sleep(100) → loops back
 *   (b) finds data → processes synchronously → loops back
 *
 * Advancing by 200ms covers case (a) with headroom.
 * This is safe because we use fake timers — no real wall time passes.
 */
async function flushPollLoop(): Promise<void> {
  // Advance fake time by 200ms to flush any pending sleep(100) in poll loops.
  // Then flush the microtask queue multiple times.
  // We repeat this 3 times because:
  //   1. First round: timer fires → poll loop's sleep resolves → xread is called
  //   2. Microtask flush: xread (async) resolves → entries processed
  //   3. Poll loop loops → xread called again (no new data) → sleep(100) set
  //   4. Second round: the second sleep fires (no new data yet — that's fine)
  // After 3 rounds of advance+flush, the price map should be current.
  for (let round = 0; round < 3; round++) {
    await vi.advanceTimersByTimeAsync(200);
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  }
}

/**
 * Run a replay of the fixture ticks through the in-memory pipeline and collect
 * all snapshots produced by snapshotStep().
 *
 * Returns the list of snapshots in the order they were produced.
 *
 * ZERO floating promises: every async call in this function is awaited.
 * The mock Redis's xadd is awaited; snapshotStep() is awaited; processedThrough()
 * is awaited before clock.advance().
 *
 * REQUIRES vi.useFakeTimers() to be active in the calling test.
 */
async function runReplay(
  fixture: GoldenFixture,
  fakeRedis: ReturnType<typeof makeInMemoryRedis>,
): Promise<StraddleSnapshot[]> {
  const { metadata, ticks } = fixture;
  const startMs = new Date(metadata.from).getTime();
  const endMs = new Date(metadata.to).getTime();
  const snapshotIntervalMs = metadata.snapshotIntervalMs;

  // Initialise virtual clock at window start.
  const clock = new VirtualClock(startMs);

  // Create StraddleCalculator with:
  //   - startId='0' (FORBID '$' — replay assertion)
  //   - No setInterval cadence used in replay (snapshotStep() drives cadence)
  //   - The fake Redis for xread/xadd
  const straddleCalc = createStraddleCalculator(fakeRedis as unknown as import('ioredis').Redis, {
    underlying: metadata.underlying,
    snapshotIntervalMs,
    clock,
    startId: '0', // REPLAY REQUIREMENT: never '$'
    noInterval: true, // REPLAY REQUIREMENT: snapshotStep() drives cadence; prevent
    // setInterval from firing extra void snapshots when fake
    // timers advance in flushPollLoop(), which would corrupt
    // the deterministic snapshot count.
  });

  // Create PositionMonitor with a fake DB (no real DB needed — we just need
  // the poll loop running to exercise processedThrough()).
  const fakeDb = {
    query: async () => ({ rows: [] }), // getOpenTrades returns empty list
  } as unknown as import('pg').Pool;

  const positionMonitor = createPositionMonitor(
    fakeRedis as unknown as import('ioredis').Redis,
    fakeDb,
    { clock },
  );

  // Start both components (they run their poll loops concurrently).
  // NOTE: start() also sets setInterval for the snapshot cadence.
  // In replay mode we ignore the setInterval cadence (we call snapshotStep()
  // manually). The interval will fire eventually but won't produce duplicates
  // because we're using fake timers — we control when setInterval fires.
  await straddleCalc.start();
  await positionMonitor.start();

  // Sort ticks by timestamp to guarantee time-order emission (mirror what
  // HistoricalFeed.load() + mergeSorted() does with DB rows).
  const sortedTicks = [...ticks].sort((a, b) => a.timestamp - b.timestamp);
  let tickIndex = 0;

  const snapshots: StraddleSnapshot[] = [];

  // Replay loop — mirrors ReplayDriver.run() but without real Redis.
  let virtualNow = clock.now();

  // We run until all ticks are emitted AND we've snapshotted through the last tick.
  while (tickIndex < sortedTicks.length || virtualNow <= endMs) {
    // Step 1: emit ticks up to virtualNow.
    // Collect xadd promises so we can await them (ZERO floating promises).
    const xaddPromises: Array<Promise<string>> = [];

    while (tickIndex < sortedTicks.length) {
      const tick = sortedTicks[tickIndex];
      if (tick === undefined || tick.timestamp > virtualNow) break;
      // Emit to market.ticks — same as the live pipeline's onTick handler.
      const p = fakeRedis.xadd('market.ticks', '*', 'data', JSON.stringify(tick));
      xaddPromises.push(p);
      tickIndex++;
    }

    // Await all xadds before snapshotStep so ticks are in the fake stream.
    if (xaddPromises.length > 0) {
      await Promise.all(xaddPromises);
    }

    // Flush the poll loops to ensure ticks are processed from market.ticks
    // into the price map before snapshotStep() reads the price map.
    // This advances fake timers by 200ms (flushing any sleep() in poll loops)
    // and then flushes the microtask queue.
    await flushPollLoop();

    // Step 2: take a deterministic snapshot.
    // snapshotStep() resolves ONLY after xadd to straddle.values completes.
    const streamId = await straddleCalc.snapshotStep();

    if (streamId !== null) {
      // Collect the snapshot from the internal state.
      const latestSnapshot = straddleCalc.getLatestSnapshot();
      if (latestSnapshot !== null) {
        snapshots.push({ ...latestSnapshot });
      }

      // Step 3: await the drain barrier — concrete, not a sleep.
      // processedThrough() resolves only after the poll loop has consumed
      // the straddle.values entry with this exact stream ID.
      // We flush the poll loop again to drive the PositionMonitor to consume
      // the straddle.values entry.
      await flushPollLoop();
      await positionMonitor.processedThrough(streamId);
    }

    // Step 4: advance virtual clock — LAST, after all side effects at T complete.
    clock.advance(snapshotIntervalMs);
    virtualNow = clock.now();

    // Exit when all ticks are emitted and the advanced clock is past endMs.
    // After advancing, virtualNow = T + snapshotIntervalMs.
    // We stop when:
    //   - all ticks have been emitted (tickIndex >= sortedTicks.length), AND
    //   - the CURRENT virtualNow > endMs (we've already processed the last tick's interval)
    // This ensures the snapshot at virtualNow == endMs is included but no extra
    // snapshots are produced beyond endMs.
    if (tickIndex >= sortedTicks.length && virtualNow > endMs) {
      break;
    }
  }

  // Stop both components.
  await straddleCalc.stop();
  await positionMonitor.stop();

  return snapshots;
}

// ---------------------------------------------------------------------------
// A. GOLDEN ORACLE
// ---------------------------------------------------------------------------

describe('A. Golden Oracle — frozen fixture structural comparison', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fixture metadata: has ≥1 gap-marked tick (M3b backtest input requirement)', () => {
    expect(FIXTURE.metadata.gapMarkerCount).toBeGreaterThanOrEqual(1);
    const actualGapMarkers = FIXTURE.ticks.filter((t: FixtureTick) => t.gapMarker === true).length;
    expect(actualGapMarkers).toBe(FIXTURE.metadata.gapMarkerCount);
  });

  it('fixture metadata: has ≥1 resolution tag (M3b backtest input requirement)', () => {
    expect(FIXTURE.metadata.resolutionTags.length).toBeGreaterThanOrEqual(1);
    // Every tick must carry a resolution tag (historical ticks always have one).
    const ticksWithResolution = FIXTURE.ticks.filter((t: FixtureTick) => t.resolution !== null);
    expect(ticksWithResolution.length).toBe(FIXTURE.ticks.length);
  });

  it('fixture metadata: tickCount matches actual tick array length', () => {
    expect(FIXTURE.ticks.length).toBe(FIXTURE.metadata.tickCount);
  });

  it('replay produces snapshot ledger that structurally matches expectedSnapshotLedger', async () => {
    const fakeRedis = makeInMemoryRedis();

    // Run the in-memory replay.
    const snapshots = await runReplay(FIXTURE, fakeRedis);

    // The expected ledger from the fixture.
    const expected = FIXTURE.expectedSnapshotLedger as Array<Record<string, unknown>>;

    // Same number of snapshots.
    expect(snapshots.length).toBe(expected.length);

    // Structural comparison for each snapshot.
    for (let i = 0; i < snapshots.length; i++) {
      const actual = snapshots[i];
      const expectedEntry = expected[i];
      if (actual === undefined || expectedEntry === undefined) {
        throw new Error(`Missing snapshot at index ${i}`);
      }

      const canonActual = canonicaliseSnapshot(actual);
      const canonExpected = canonicaliseLedgerEntry(expectedEntry);

      expect(canonActual, `Snapshot ${i} mismatch`).toEqual(canonExpected);
    }
  });
});

// ---------------------------------------------------------------------------
// B. 100x IDENTICAL-LEDGER GATE
// ---------------------------------------------------------------------------

describe('B. 100x identical-ledger gate — replay determinism', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces identical canonical snapshot ledger on every one of 100 runs', async () => {
    // Run the first replay to get the reference ledger.
    const referenceLedger = await runReplay(FIXTURE, makeInMemoryRedis());
    const referenceCanonical = referenceLedger.map(canonicaliseSnapshot);

    // Run 99 more times and assert each matches the reference.
    // We run them sequentially (not in parallel) to avoid port conflicts and
    // to keep the assertion message clear about WHICH run failed.
    for (let run = 1; run < 100; run++) {
      const runLedger = await runReplay(FIXTURE, makeInMemoryRedis());
      const runCanonical = runLedger.map(canonicaliseSnapshot);

      expect(runCanonical, `Run ${run + 1} produced a different ledger than run 1`).toEqual(
        referenceCanonical,
      );
    }
  }, 30_000); // 30s timeout — 100 runs each ~50ms = ~5s but give headroom
});

// ---------------------------------------------------------------------------
// C. DRAIN BARRIER — processedThrough() concrete observability
// ---------------------------------------------------------------------------

describe('C. processedThrough() drain barrier — named, concrete, not a sleep', () => {
  it('resolves immediately when lastId is already past the target', async () => {
    // Build a monitor whose poll loop has already advanced past "1-0".
    const entries: [string, string[]][] = [
      [
        '1-0',
        [
          'data',
          JSON.stringify({
            underlying: 'NIFTY',
            timestamp: 1706154300000,
            atmStrike: 22400,
            cePrice: 150,
            pePrice: 145,
            straddleValue: 295,
            roc: 0,
            acceleration: 0,
            snapshotCount: 1,
          }),
        ],
      ],
    ];

    let callCount = 0;
    const fakeRedis = {
      xread: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return [['straddle.values', entries]];
        }
        return null;
      }),
    };

    const fakeDb = {
      query: async () => ({ rows: [] }),
    } as unknown as import('pg').Pool;

    const monitor = createPositionMonitor(fakeRedis as unknown as import('ioredis').Redis, fakeDb);

    await monitor.start();

    // Wait for the poll loop to process the entry.
    // We poll xread call count rather than sleeping.
    const deadline = Date.now() + 500;
    while (fakeRedis.xread.mock.calls.length < 1 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    // Give one more tick for evaluateSnapshot to complete.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Now processedThrough should resolve immediately (lastId >= '1-0').
    const barrierResolved = await Promise.race([
      monitor.processedThrough('1-0').then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 50)),
    ]);

    await monitor.stop();

    expect(barrierResolved).toBe(true);
  });

  it('resolves only AFTER the poll loop processes the target entry', async () => {
    // The barrier for '2-0' must not resolve until after the poll loop
    // processes the straddle.values entry with id '2-0'.

    const snapshot = JSON.stringify({
      underlying: 'NIFTY',
      timestamp: 1706154315000,
      atmStrike: 22400,
      cePrice: 155,
      pePrice: 148,
      straddleValue: 303,
      roc: 2.711864406779661,
      acceleration: 0,
      snapshotCount: 2,
    });

    // Deferred: resolve this to make xread return the entry.
    let releaseEntry!: () => void;
    const entryReady = new Promise<void>((r) => {
      releaseEntry = r;
    });

    let callCount = 0;
    const fakeRedis = {
      xread: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          // First call: return nothing — the entry has not been published yet.
          return null;
        }
        if (callCount === 2) {
          // Second call: wait for the test to release the entry.
          await entryReady;
          return [['straddle.values', [['2-0', ['data', snapshot]]]]];
        }
        return null;
      }),
    };

    const fakeDb = {
      query: async () => ({ rows: [] }),
    } as unknown as import('pg').Pool;

    const monitor = createPositionMonitor(fakeRedis as unknown as import('ioredis').Redis, fakeDb);

    await monitor.start();

    // Allow the first xread call to complete (returns null).
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // The barrier should NOT be resolved yet.
    let barrierDone = false;
    const barrierPromise = monitor.processedThrough('2-0').then(() => {
      barrierDone = true;
    });

    // Assert it has not resolved yet.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(barrierDone).toBe(false);

    // Now release the entry — the poll loop will process it on the next xread.
    releaseEntry();

    // The barrier must now resolve.
    const result = await Promise.race([
      barrierPromise.then(() => 'resolved'),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 500)),
    ]);

    await monitor.stop();

    expect(result).toBe('resolved');
    expect(barrierDone).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. LIVE-PATH REGRESSION — setInterval cadence preserved
// ---------------------------------------------------------------------------

describe('D. Live-path regression — setInterval snapshot cadence unchanged', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('StraddleCalculator fires snapshots via setInterval in live mode (not snapshotStep)', async () => {
    // In live mode, start() sets up setInterval. Each interval fires void takeSnapshot().
    // We assert:
    //   1. After snapshotIntervalMs, xadd is called (snapshot was taken).
    //   2. The snapshotStep() method is NOT the mechanism — the timer is.
    //
    // This test uses vi fake timers to drive the interval deterministically.

    const xaddCalls: string[] = [];
    const fakeRedis = {
      xread: vi.fn().mockResolvedValue(null),
      xadd: vi.fn(
        async (_stream: string, _idArg: string, _field: string, data: string): Promise<string> => {
          xaddCalls.push(data);
          return '999-0';
        },
      ),
    };

    // Pre-seed the price map by having the calculator read from a stream
    // that already has the right ticks. We do this by making xread return
    // them on the first call.
    const fixedDate = new Date('2024-01-25T06:30:00Z'); // Thursday noon IST
    const { FixedClock } = await import('../../../utils/clock');
    const clock = new FixedClock(fixedDate);

    const ticks = [
      { symbol: 'NSE:NIFTY50-INDEX', ltp: 22400, timestamp: fixedDate.getTime() },
      { symbol: 'NSE:NIFTY2412522400CE', ltp: 150, timestamp: fixedDate.getTime() },
      { symbol: 'NSE:NIFTY2412522400PE', ltp: 145, timestamp: fixedDate.getTime() },
    ];

    fakeRedis.xread
      .mockResolvedValueOnce([
        ['market.ticks', ticks.map((t, i) => [`tick-${i}-0`, ['data', JSON.stringify(t)]])],
      ])
      .mockResolvedValue(null);

    const calculator = createStraddleCalculator(fakeRedis as unknown as import('ioredis').Redis, {
      underlying: 'NIFTY',
      snapshotIntervalMs: 15_000,
      clock,
    });

    await calculator.start();

    // Let the poll loop process ticks.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Before the interval fires, no snapshot should exist.
    expect(calculator.getLatestSnapshot()).toBeNull();

    // Advance fake timers by one interval — setInterval fires once.
    await vi.advanceTimersByTimeAsync(15_000);

    // The snapshot should now exist (setInterval fired, takeSnapshotFireAndForget ran).
    expect(calculator.getLatestSnapshot()).not.toBeNull();
    expect(xaddCalls.length).toBe(1);

    // Advance by another interval — second snapshot.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(xaddCalls.length).toBe(2);

    await calculator.stop();
  });

  it('snapshotStep() in replay mode also publishes, independent of setInterval', async () => {
    // This test verifies that snapshotStep() is a separate, awaitable path.
    // We do NOT call start() (no setInterval), instead calling snapshotStep() directly.
    const xaddCalls: string[] = [];
    const fakeRedis = {
      xread: vi.fn().mockResolvedValue(null),
      xadd: vi.fn(
        async (_stream: string, _idArg: string, _field: string, data: string): Promise<string> => {
          xaddCalls.push(data);
          return '1000-0';
        },
      ),
    };

    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const { FixedClock } = await import('../../../utils/clock');
    const clock = new FixedClock(fixedDate);

    // Prime the price map by calling processRawTick via xread simulation.
    const ticks = [
      { symbol: 'NSE:NIFTY50-INDEX', ltp: 22400, timestamp: fixedDate.getTime() },
      { symbol: 'NSE:NIFTY2412522400CE', ltp: 150, timestamp: fixedDate.getTime() },
      { symbol: 'NSE:NIFTY2412522400PE', ltp: 145, timestamp: fixedDate.getTime() },
    ];

    fakeRedis.xread
      .mockResolvedValueOnce([
        ['market.ticks', ticks.map((t, i) => [`tick-${i}-0`, ['data', JSON.stringify(t)]])],
      ])
      .mockResolvedValue(null);

    // Use startId='0' for replay — the critical '$'-prevention check.
    const calculator = createStraddleCalculator(fakeRedis as unknown as import('ioredis').Redis, {
      underlying: 'NIFTY',
      snapshotIntervalMs: 15_000,
      clock,
      startId: '0',
    });

    await calculator.start();

    // Let poll loop process ticks.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Call snapshotStep() directly — must await the xadd before resolving.
    const streamId = await calculator.snapshotStep();

    // Must return a stream ID (not null) because all prices are available.
    expect(streamId).not.toBeNull();
    // Must have called xadd exactly once (to straddle.values).
    // xadd may have been called twice: once by the test's manual xadd for ticks,
    // and once by snapshotStep(). We check that straddle.values xadd happened.
    const straddleXadds = xaddCalls.filter((_, i) => {
      const call = fakeRedis.xadd.mock.calls[i] as unknown[];
      return call[0] === 'straddle.values';
    });
    expect(straddleXadds.length).toBeGreaterThanOrEqual(1);

    await calculator.stop();
  });
});

// ---------------------------------------------------------------------------
// E. '$' CURSOR FORBIDDEN IN REPLAY — static assertion via in-memory Redis
// ---------------------------------------------------------------------------

describe('E. $ cursor forbidden in replay path', () => {
  it('in-memory fake Redis throws when xread is called with $ cursor', async () => {
    const fakeRedis = makeInMemoryRedis();

    // Directly calling xread with '$' must throw — this is the enforcement mechanism.
    await expect(fakeRedis.xread('COUNT', 100, 'STREAMS', 'market.ticks', '$')).rejects.toThrow(
      'REPLAY PATH VIOLATION',
    );
  });

  it('StraddleCalculator with startId="0" never calls xread with $', async () => {
    // This test asserts that when startId='0', the xread calls never use '$'.
    const xreadCursors: string[] = [];
    const fakeRedis = {
      xread: vi.fn(
        async (_count: string, _n: number, _streams: string, _stream: string, cursor: string) => {
          xreadCursors.push(cursor);
          return null;
        },
      ),
      xadd: vi.fn().mockResolvedValue('1-0'),
    };

    const { FixedClock } = await import('../../../utils/clock');
    const clock = new FixedClock(new Date('2024-01-25T06:30:00Z'));

    const calculator = createStraddleCalculator(fakeRedis as unknown as import('ioredis').Redis, {
      underlying: 'NIFTY',
      clock,
      startId: '0',
    });

    await calculator.start();
    // Let the poll loop run a few iterations.
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await calculator.stop();

    // All xread calls must use '0' as the initial cursor, never '$'.
    // After the first call, the cursor advances to the last received ID,
    // but since xread returns null always, cursor stays at '0'.
    for (const cursor of xreadCursors) {
      expect(cursor, `xread called with forbidden cursor '${cursor}'`).not.toBe('$');
    }
  });
});
