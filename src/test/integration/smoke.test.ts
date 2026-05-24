/**
 * End-to-end smoke test for the full trading pipeline.
 *
 * This test wires up all pipeline components (straddle calculator, VIX feed,
 * entry engine, position monitor, paper trade executor, and Fastify server)
 * using the same VirtualClock-driven approach as index.ts simulation mode.
 *
 * Key design decisions:
 * - Uses the real module-level redis singleton (src/redis/client.ts) for
 *   stream consumption (streamConsume is bound to it). The straddle calculator
 *   is also pointed at that singleton so publishes and consumes share the same
 *   Redis connection — consistent with production wiring.
 * - Uses a SEPARATE test PostgreSQL pool (createTestDb) so that data writes
 *   do not touch any shared database state. cleanTestDb truncates between runs.
 * - VirtualClock is advanced explicitly to trigger interval callbacks
 *   (straddle snapshots, watchdog) without waiting for real wall-clock time.
 * - After each clock.advance() we poll the database with waitFor() rather
 *   than using a fixed sleep, because advance() is synchronous but the async
 *   DB/Redis side-effects complete some milliseconds later.
 * - The smoke test is intentionally coarse-grained: it verifies that the
 *   pipeline produces observable outputs (DB rows, WebSocket messages) given
 *   simulated time advancement. It is NOT a unit test of individual components.
 *
 * Requires Docker services (PostgreSQL + Redis) to be running.
 * Run with: bun run test:integration
 */

import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../api/server.js';
import { createBroker } from '../../ingestion/brokers/broker-factory.js';
import {
  type StraddleCalculator,
  createStraddleCalculator,
} from '../../ingestion/straddle-calc.js';
import { type VixFeed, createVixFeed } from '../../ingestion/vix-feed.js';
// We intentionally use the module-level redis singleton for stream consumption,
// so all stream publish/consume goes through the same Redis connection.
import { redis } from '../../redis/client.js';
import { EntryEngine } from '../../trading/entry-engine.js';
import { PaperTradeExecutor } from '../../trading/paper-trade-executor.js';
import { PositionMonitor } from '../../trading/position-monitor.js';
import { QuantiplyStub } from '../../trading/quantiply-stub.js';
import { loadTriggerConfig } from '../../trading/trigger-engine.js';
import { VirtualClock } from '../../utils/clock.js';
import { cleanTestDb, createTestDb } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Polls an async condition every 200ms until it returns true or the timeout elapses.
 * Used after clock.advance() calls because advance() is synchronous but the
 * downstream DB/Redis side-effects complete asynchronously.
 */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Test state (shared across all tests in the describe block)
// ---------------------------------------------------------------------------

// 09:14 IST on 2026-01-15 = 03:44 UTC on 2026-01-15
const START_EPOCH_MS = new Date('2026-01-15T03:44:00.000Z').getTime();

let testDb: Pool;
let clock: VirtualClock;
let calc: StraddleCalculator;
let vixFeed: VixFeed;
let entryEngine: EntryEngine;
let executor: PaperTradeExecutor;
let positionMonitor: PositionMonitor;
let server: FastifyInstance;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // ---- Environment ----
  // Set entry window wide enough that the test can trigger entries.
  // 09:00–15:30 IST covers the simulated times we use.
  process.env.ENTRY_START_TIME = '09:00';
  process.env.ENTRY_CUTOFF_TIME = '15:30';
  process.env.SIMULATE = 'true';

  // ---- Database ----
  // createTestDb() runs migrations against the test database so the schema is current.
  testDb = await createTestDb();
  await cleanTestDb(testDb);

  // Ensure the module-level redis is also flushed so stale stream messages from
  // previous test runs do not interfere. We target only db 0 (FLUSHDB).
  await (redis as Redis).flushdb();

  // ---- Clock ----
  // Start at 09:14 IST — within the entry window, before any straddle interval
  // fires. Straddle interval is 15 000ms, so the first snapshot fires when we
  // advance past a 15s boundary.
  clock = new VirtualClock(START_EPOCH_MS);

  // ---- Components ----
  // createBroker reads SIMULATE=true and creates a MarketDataSimulator. The
  // simulator uses clock.tick() internally to drive synthetic tick generation.
  const broker = createBroker(clock);

  // StraddleCalculator uses the module-level redis singleton for publishing so
  // that the straddle.values stream is visible to the module-level streamConsume
  // calls in EntryEngine and PositionMonitor.
  calc = createStraddleCalculator(redis as Redis, { underlying: 'NIFTY', clock });

  // VixFeed is network-dependent (NSE API). In simulation mode it will fail
  // to fetch VIX but that is acceptable — vixAtEntry will be null on trades.
  vixFeed = createVixFeed(redis as Redis, { clock });

  entryEngine = new EntryEngine({ db: testDb, redis: redis as Redis, clock });

  const quantiply = new QuantiplyStub();
  executor = new PaperTradeExecutor({ db: testDb, quantiply });

  positionMonitor = new PositionMonitor({
    clock,
    db: testDb,
    redis: redis as Redis,
    executor,
    triggerConfig: loadTriggerConfig(),
    // Short stale threshold so the watchdog fires quickly in tests.
    staleThresholdMs: 10_000,
    entryEngine,
  });

  // ---- Start components ----
  broker.onTick((tick) => {
    void (redis as Redis).xadd('market.ticks', '*', 'data', JSON.stringify(tick));
  });
  broker.connect();
  calc.start();
  vixFeed.start();
  await positionMonitor.start();
  entryEngine.start();

  // Start server on a random port (port 0) so CI never has a port conflict.
  server = buildServer({ db: testDb, redis: redis as Redis, clock });
  await server.listen({ port: 0, host: '127.0.0.1' });
}, 30_000); // 30s timeout for Docker service connections

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterAll(async () => {
  // Guard: if beforeAll failed (e.g. Docker not running), components are undefined.
  // Calling stop() on undefined produces a misleading secondary error that masks
  // the real failure; these guards make the test output point to the root cause.
  if (entryEngine) entryEngine.stop();
  if (positionMonitor) await positionMonitor.stop();
  if (calc) calc.stop();
  if (vixFeed) vixFeed.stop();
  if (server) await server.close();
  if (testDb) await testDb.end();
  // Do NOT call closeRedis() here — that shuts down the shared module-level
  // singleton which may be used by other test files in the same Vitest worker.
  // Flushing is sufficient for isolation; the singleton persists across test files.
  if (redis) await (redis as Redis).flushdb();
}, 15_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('full pipeline smoke test', () => {
  it('pipeline starts without error', () => {
    // The Fastify server must be listening. server.server is the underlying
    // Node/Bun http.Server; its .listening property is true once listen() has
    // resolved. This is the fastest possible canary that the setup succeeded.
    expect(server.server.listening).toBe(true);
  });

  it('straddle snapshot published after advancing clock to 09:17 IST', async () => {
    // Advance the clock by 3 minutes (180 000ms).
    // The straddle snapshot interval is 15 000ms, so this crosses 12 interval
    // boundaries and should trigger 12 snapshot publishes — at least one DB
    // row should appear in straddle_snapshots.
    // 09:17 IST = 03:47 UTC
    clock.advance(180_000);

    await waitFor(async () => {
      const result = await testDb.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM straddle_snapshots',
      );
      return Number(result.rows[0]?.count ?? 0) > 0;
    }, 5_000);

    const result = await testDb.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM straddle_snapshots',
    );
    expect(Number(result.rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it('entry signal produced and paper trade opened between 09:14 and 09:17 IST', async () => {
    // The entry engine listens on the straddle.values stream and emits an
    // EntryIntent when all gates pass (time window, no open position, etc.).
    // The position monitor bridges EntryIntent → openTrade().
    // After the straddle publishes snapshots at 09:14–09:17 we expect at least
    // one paper_trade row (either open or closed if the watchdog already ran).
    await waitFor(async () => {
      const result = await testDb.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM paper_trades',
      );
      return Number(result.rows[0]?.count ?? 0) > 0;
    }, 5_000);

    const result = await testDb.query<{ id: string; status: string }>(
      'SELECT id, status FROM paper_trades LIMIT 1',
    );
    expect(result.rows.length).toBeGreaterThan(0);
    // Status is 'open' or 'closed' — both are valid at this stage.
    expect(['open', 'closed']).toContain(result.rows[0]?.status);
  });

  it('EOD exit closes all open positions at 15:25 IST', async () => {
    // 15:25 IST = 09:55 UTC on the same date.
    // The target epoch in ms:
    const eodEpochMs = new Date('2026-01-15T09:55:00.000Z').getTime();
    // How much to advance: eodEpochMs minus current clock position.
    // Current clock is at START_EPOCH_MS + 180_000 = 03:47 UTC.
    const currentMs = START_EPOCH_MS + 180_000;
    const advanceBy = eodEpochMs - currentMs;

    // Advance in chunks to give async handlers time to process between
    // interval boundaries. A single massive advance can fire many watchdog
    // callbacks synchronously before any of their async DB writes complete,
    // so we chunk to avoid overwhelming the DB connection pool.
    const chunkMs = 60_000; // advance 1 minute at a time
    let remaining = advanceBy;
    while (remaining > 0) {
      const step = Math.min(chunkMs, remaining);
      clock.advance(step);
      // Brief yield to allow async I/O (DB writes from watchdog / stream handlers)
      // to make progress between chunks. This is not a fixed sleep — it gives the
      // event loop a turn to process the microtask queue after each advance.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      remaining -= step;
    }

    // Wait for all open positions to be closed by EOD trigger or watchdog.
    await waitFor(async () => {
      const result = await testDb.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM paper_trades WHERE status = 'open'",
      );
      return Number(result.rows[0]?.count ?? 0) === 0;
    }, 8_000);

    // All trades must be closed by now.
    const openResult = await testDb.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM paper_trades WHERE status = 'open'",
    );
    expect(Number(openResult.rows[0]?.count ?? 0)).toBe(0);

    // Closed rows must have non-null P&L fields.
    const closedResult = await testDb.query<{
      gross_pnl: string | null;
      net_pnl: string | null;
    }>("SELECT gross_pnl, net_pnl FROM paper_trades WHERE status = 'closed'");

    for (const row of closedResult.rows) {
      expect(row.gross_pnl).not.toBeNull();
      expect(row.net_pnl).not.toBeNull();
    }
  });

  it('WebSocket broadcasts straddle ticks', async () => {
    // The straddle.values stream has data from previous tests (we advanced to 15:25).
    // Open a WebSocket connection and wait for at least one message.
    //
    // We advance the clock slightly to produce a fresh snapshot so the WS
    // broadcast loop has something to send to our new subscriber.
    clock.advance(15_000); // one more straddle interval

    const address = server.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected server address format');
    }
    const wsUrl = `ws://127.0.0.1:${address.port}/ws/ticks`;

    const message = await new Promise<string>((resolve, reject) => {
      // Bun's test environment provides a global WebSocket. Node.js environments
      // without it fall back to the 'ws' package via dynamic import.
      if (typeof WebSocket !== 'undefined') {
        const native = new WebSocket(wsUrl);
        native.onmessage = (event: MessageEvent) => {
          resolve(event.data as string);
          native.close();
        };
        native.onerror = (event: Event) => {
          reject(new Error(`WebSocket error: ${String(event)}`));
        };
      } else {
        // Fallback: dynamic import of the 'ws' package for environments without
        // a global WebSocket (older Node.js versions, some CI runtimes).
        // @ts-expect-error — 'ws' has no @types/ws in this project; the Bun runtime
        // takes the branch above, so this fallback only runs in Node-only CI.
        import('ws')
          .then((mod: unknown) => {
            // Resolve constructor from either ESM default export or CJS module object.
            const modObj = mod as Record<string, unknown>;
            const WsCtor = (modObj.default ?? mod) as new (
              url: string,
            ) => {
              on(event: string, handler: (data: unknown) => void): void;
              close(): void;
            };
            const wsClient = new WsCtor(wsUrl);
            wsClient.on('message', (data: unknown) => {
              const str =
                typeof data === 'string'
                  ? data
                  : Buffer.isBuffer(data)
                    ? data.toString()
                    : String(data);
              resolve(str);
              wsClient.close();
            });
            wsClient.on('error', (err: unknown) =>
              reject(err instanceof Error ? err : new Error(String(err))),
            );
          })
          .catch(reject);
      }
    });

    // The WebSocket payload is JSON: { id: string; fields: Record<string, string> }
    // fields should contain straddleValue (the field name published by straddle-calc.ts).
    const parsed = JSON.parse(message) as { id: string; fields: Record<string, string> };
    expect(parsed).toHaveProperty('fields');
    expect(parsed.fields).toHaveProperty('straddleValue');
  });
});
