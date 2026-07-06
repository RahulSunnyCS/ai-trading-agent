/**
 * Deterministic Replay Script — bun run replay
 *
 * Usage:
 *   bun run replay [options]
 *
 * Options:
 *   --from <ISO>           Replay window start (e.g. 2024-01-25T03:45:00Z)
 *   --to   <ISO>           Replay window end (e.g. 2024-01-25T09:30:00Z)
 *   --underlying <name>    NIFTY | BANKNIFTY | SENSEX (default: NIFTY)
 *   --speed <multiplier>   Virtual time speed multiplier for log output (default: 1.0)
 *   --verbose              Log each emitted tick (very noisy for large windows)
 *   --regenerate-fixture   Regenerate src/ingestion/historical/__tests__/fixtures/golden/fixture.json
 *                          from the golden scenario (developer-only; never run in CI)
 *   --dry-run              Connect and load ticks but do not start the live pipeline components
 *
 * Environment:
 *   DATABASE_URL   PostgreSQL connection string (required unless --dry-run)
 *   REDIS_URL      Redis connection string (required unless --dry-run)
 *                  Defaults to redis://localhost:6379
 *
 * Exit codes:
 *   0  — replay completed successfully
 *   1  — fatal error (misconfiguration, DB unreachable, etc.)
 *
 * IMPORTANT: This script connects to the REAL database and REAL Redis.
 *   All ticks are written to market.ticks and straddle.values Redis streams.
 *   The position monitor writes paper-trade exits to the paper_trades table.
 *   Use a separate test database / Redis database number for development replays.
 *
 * Security notes:
 *   - No user-supplied values are interpolated into SQL.
 *   - All DB queries use the HistoricalFeed which uses parameterised queries.
 *   - REDIS_URL and DATABASE_URL are read from environment (not from args) to
 *     prevent credential leakage in process lists.
 */

import Redis from 'ioredis';
import pg from 'pg';

import { runMigrations } from '../src/db/migrate.js';
import type { Underlying } from '../src/ingestion/brokers/types.js';
import { createHistoricalFeed } from '../src/ingestion/historical/historical-feed.js';
import { createReplayDriver } from '../src/ingestion/historical/replay-driver.js';
import { createStraddleCalculator } from '../src/ingestion/straddle-calc.js';
import {
  PeakDetectionEngine,
  readConfigFromEnv as readPeakConfigFromEnv,
} from '../src/signals/peak-detection-engine.js';
import { PersonalityRouter } from '../src/signals/personality-router.js';
import {
  ScheduledSignalEmitter,
  buildConfigFromEnv as buildScheduledConfigFromEnv,
} from '../src/signals/scheduled-signal-emitter.js';
import { createPositionMonitor } from '../src/trading/position-monitor.js';
import { VirtualClock } from '../src/utils/clock.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  from: Date | null;
  to: Date | null;
  underlying: Underlying;
  speed: number;
  verbose: boolean;
  regenerateFixture: boolean;
  dryRun: boolean;
  againstLive: boolean;
} {
  const args = argv.slice(2); // strip 'bun' and script path

  let from: Date | null = null;
  let to: Date | null = null;
  let underlying: Underlying = 'NIFTY';
  let speed = 1.0;
  let verbose = false;
  let regenerateFixture = false;
  let dryRun = false;
  // --against-live: explicit opt-in required to run replay against a non-scratch DB.
  // Without this flag, replay refuses to run against DATABASE_URL so it cannot
  // silently close real open paper trades via the PositionMonitor.
  let againstLive = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--from': {
        const val = args[++i];
        if (!val) {
          console.error('--from requires a value');
          process.exit(1);
        }
        from = new Date(val);
        if (Number.isNaN(from.getTime())) {
          console.error(`Invalid --from value: ${val}`);
          process.exit(1);
        }
        break;
      }
      case '--to': {
        const val = args[++i];
        if (!val) {
          console.error('--to requires a value');
          process.exit(1);
        }
        to = new Date(val);
        if (Number.isNaN(to.getTime())) {
          console.error(`Invalid --to value: ${val}`);
          process.exit(1);
        }
        break;
      }
      case '--underlying': {
        const val = args[++i] as Underlying;
        if (!val || !['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(val)) {
          console.error(
            `Invalid --underlying value: ${val ?? '(missing)'}. Must be NIFTY | BANKNIFTY | SENSEX`,
          );
          process.exit(1);
        }
        underlying = val;
        break;
      }
      case '--speed': {
        const val = args[++i];
        const parsed = Number.parseFloat(val ?? '');
        if (!Number.isFinite(parsed) || parsed <= 0) {
          console.error(`Invalid --speed value: ${val ?? '(missing)'}. Must be a positive number.`);
          process.exit(1);
        }
        speed = parsed;
        break;
      }
      case '--verbose': {
        verbose = true;
        break;
      }
      case '--regenerate-fixture': {
        regenerateFixture = true;
        break;
      }
      case '--dry-run': {
        dryRun = true;
        break;
      }
      case '--against-live': {
        // Explicit acknowledgement that this replay will connect to the live DB
        // and Redis and that the PositionMonitor may close real open paper trades.
        againstLive = true;
        break;
      }
      default:
        console.warn(`[replay] Unknown argument: ${arg}`);
    }
  }

  return { from, to, underlying, speed, verbose, regenerateFixture, dryRun, againstLive };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  if (opts.regenerateFixture) {
    console.log(
      '[replay] --regenerate-fixture: regenerating golden fixture (developer mode, NOT CI)',
    );
    await regenerateGoldenFixture();
    return;
  }

  if (!opts.from || !opts.to) {
    console.error('[replay] --from and --to are required. Example:');
    console.error(
      '  bun run replay --from 2024-01-25T03:45:00Z --to 2024-01-25T10:00:00Z --underlying NIFTY',
    );
    process.exit(1);
  }

  if (opts.from >= opts.to) {
    console.error('[replay] --from must be before --to');
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Live-DB guard — default invocation must NOT silently close real trades
  // ---------------------------------------------------------------------------
  //
  // The PositionMonitor in replay mode evaluates ALL open paper_trades and can
  // close them against replayed historical prices. Without an explicit opt-in,
  // a developer who runs `bun run replay` against the production DATABASE_URL
  // could wipe out all live open positions with no warning.
  //
  // Guard: require --against-live OR REPLAY_CONFIRM_LIVE=true env var before
  // proceeding. The --dry-run path is exempt (it does not start the pipeline).
  //
  // To run replay against a scratch / test database, point DATABASE_URL at a
  // non-production connection string. No flag is needed for that case — the flag
  // is the human's acknowledgement that the *current* DATABASE_URL is live.
  const replayConfirmLive = process.env.REPLAY_CONFIRM_LIVE === 'true';
  if (!opts.dryRun && !opts.againstLive && !replayConfirmLive) {
    console.error('[replay] SAFETY GUARD: replay connects to the live DATABASE_URL and can close');
    console.error('[replay] real open paper trades via the PositionMonitor.');
    console.error('[replay]');
    console.error('[replay] To proceed, add --against-live (or set REPLAY_CONFIRM_LIVE=true).');
    console.error('[replay] Use --dry-run to connect and load ticks without running the pipeline.');
    console.error('[replay] Point DATABASE_URL at a replay/scratch database to avoid this guard.');
    process.exit(1);
  }

  console.log('[replay] Starting deterministic replay');
  console.log(`[replay]   Underlying : ${opts.underlying}`);
  console.log(`[replay]   From       : ${opts.from.toISOString()}`);
  console.log(`[replay]   To         : ${opts.to.toISOString()}`);
  console.log(`[replay]   Speed      : ${opts.speed}x`);
  console.log(`[replay]   Verbose    : ${opts.verbose}`);
  if (opts.againstLive || replayConfirmLive) {
    console.log(
      '[replay]   LIVE MODE  : --against-live acknowledged — PositionMonitor may close real trades',
    );
  }

  // ---------------------------------------------------------------------------
  // Connect to real infrastructure
  // ---------------------------------------------------------------------------

  const dbUrl = process.env.DATABASE_URL ?? 'postgresql://trading:trading@localhost:5432/trading';
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

  // Run migrations to ensure schema is current before starting replay.
  await runMigrations();

  const pool = new pg.Pool({ connectionString: dbUrl });
  const redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });

  // ---------------------------------------------------------------------------
  // Build pipeline components
  // ---------------------------------------------------------------------------

  const virtualStart = opts.from.getTime();
  const clock = new VirtualClock(virtualStart);

  const SNAPSHOT_INTERVAL_MS = 15_000;

  // StraddleCalculator in replay mode:
  //   - startId='0' (FORBID '$' cursors — replay requirement)
  //   - No setInterval — snapshotStep() drives cadence
  const straddleCalc = createStraddleCalculator(redisClient, {
    underlying: opts.underlying,
    snapshotIntervalMs: SNAPSHOT_INTERVAL_MS,
    clock,
    startId: '0', // REPLAY: never '$'
    // REPLAY: no wall-clock setInterval — snapshotStep() drives cadence. Without
    // this, start() would fire extra wall-clock snapshots for any replay longer
    // than one interval (~15s), breaking the deterministic replay guarantee.
    noInterval: true,
  });

  // PositionMonitor in replay mode:
  //   - Poll loop runs concurrently (it reads straddle.values)
  //   - processedThrough() is the drain barrier
  const positionMonitor = createPositionMonitor(redisClient, pool, { clock });

  // HistoricalFeed: reads ticks from DB for the window.
  const feed = createHistoricalFeed(pool, {
    underlying: opts.underlying,
    from: opts.from,
    to: opts.to,
  });

  if (opts.dryRun) {
    console.log('[replay] --dry-run: connecting and loading ticks but not running pipeline');
    const count = await feed.load();
    console.log(`[replay] Loaded ${count} ticks. Dry run complete.`);
    await pool.end();
    await redisClient.quit();
    return;
  }

  // Load all ticks into memory before starting the pipeline components.
  // This ensures no race condition between DB fetch and the driver loop.
  const tickCount = await feed.load();
  console.log(`[replay] Loaded ${tickCount} ticks from DB`);

  // Start pipeline components before wiring the feed so poll loops are ready.
  await straddleCalc.start();
  await positionMonitor.start();

  // Signal generators — both consume straddle.values and publish to
  // signals.generated. Started AFTER straddleCalc/positionMonitor so their
  // consumer groups exist at '$' = current end-of-stream (empty at this point),
  // and BEFORE the replay driver starts publishing snapshots — guaranteeing
  // they see every replay snapshot. Without these, signals.generated stays
  // empty and the personality engine never fires entries.
  //
  // IMPORTANT: each blocking consumer (XREADGROUP BLOCK 2s) gets its OWN
  // duplicated Redis client. ioredis holds the connection during BLOCK, so a
  // shared client would queue every XADD / XREAD behind the engines' blocks —
  // empirically a 13-second 30-min replay became a 10+ minute crawl.
  const peakRedis = redisClient.duplicate();
  const scheduledRedis = redisClient.duplicate();
  const routerRedis = redisClient.duplicate();
  const peakEngine = new PeakDetectionEngine(pool, peakRedis, readPeakConfigFromEnv(), clock);
  const scheduledEmitter = new ScheduledSignalEmitter(
    scheduledRedis,
    buildScheduledConfigFromEnv(),
    clock,
  );
  // PersonalityRouter consumes signals.generated and writes paper_trades for
  // personalities that accept. Without it, signals fire but no trade is ever
  // opened — the final missing link in the live + replay pipeline.
  const personalityRouter = new PersonalityRouter(pool, routerRedis, clock);
  await peakEngine.start();
  await personalityRouter.start();
  // ScheduledSignalEmitter.start() runs the consume loop inline — fire-and-forget.
  void scheduledEmitter.start();

  // NOTE: tick publishing to market.ticks is owned by the ReplayDriver, which
  // registers its own feed.onTick handler and awaits every xadd (zero floating
  // promises) before each snapshotStep(). We must NOT register a second onTick
  // publisher here — doing so would publish every tick twice and float the
  // promise, corrupting the deterministic replay.

  // Create and run the replay driver.
  const driver = createReplayDriver(feed, redisClient, straddleCalc, positionMonitor, clock, {
    snapshotIntervalMs: SNAPSHOT_INTERVAL_MS,
    speedMultiplier: opts.speed,
    verboseTicks: opts.verbose,
  });

  console.log('[replay] Starting replay driver...');
  const summary = await driver.run();

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  console.log('\n[replay] ══ Replay Complete ══');
  console.log(`[replay]   Ticks emitted          : ${summary.ticksEmitted}`);
  console.log(`[replay]   Snapshot steps total   : ${summary.snapshotStepsAttempted}`);
  console.log(`[replay]   Snapshots published    : ${summary.snapshotStepsPublished}`);
  console.log(
    `[replay]   Virtual time spanned   : ${(summary.virtualMs / 1000 / 60).toFixed(1)} min`,
  );
  console.log(`[replay]   Wall-clock elapsed     : ${(summary.wallClockMs / 1000).toFixed(2)} s`);
  console.log(
    `[replay]   Effective speed        : ${(summary.virtualMs / summary.wallClockMs).toFixed(1)}x`,
  );

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  // Give the signal engines a short drain window so they consume the final
  // snapshots before we stop them. Both use a 2s BLOCK on XREADGROUP, so 3s
  // wall-clock is enough for one extra read cycle after the last publish.
  await new Promise<void>((resolve) => setTimeout(resolve, 3000));
  await peakEngine.stop();
  await scheduledEmitter.stop();
  await personalityRouter.stop();

  // Report what landed BEFORE closing the Redis client.
  const signalsLen = await redisClient.xlen('signals.generated').catch(() => 0);
  console.log(`[replay]   Signals generated      : ${signalsLen}`);

  await straddleCalc.stop();
  await positionMonitor.stop();
  await pool.end();
  // Close engine-owned connections first, then the primary client.
  await peakRedis.quit();
  await scheduledRedis.quit();
  await routerRedis.quit();
  await redisClient.quit();

  console.log('[replay] Clean shutdown complete.');
}

// ---------------------------------------------------------------------------
// Fixture regeneration (developer-only, never run in CI)
// ---------------------------------------------------------------------------

async function regenerateGoldenFixture(): Promise<void> {
  // This function regenerates the golden fixture from the hardcoded synthetic
  // scenario. It is run manually by the developer after an algorithm change.
  // It must NOT be run in CI — CI always uses the frozen fixture.

  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');

  // The scenario parameters (must match the frozen fixture exactly when not regenerating).
  const START = 1706154300000; // 2024-01-25T03:45:00Z
  const INTERVAL = 15_000;
  const UNDERLYING: Underlying = 'NIFTY';

  // Synthetic ticks — same as the fixture but generated programmatically.
  const syntheticTicks = [
    {
      symbol: 'NSE:NIFTY50-INDEX',
      ltp: 22400,
      timestamp: START,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
    {
      symbol: 'NSE:NIFTY2412522400CE',
      ltp: 150,
      timestamp: START,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
    {
      symbol: 'NSE:NIFTY2412522400PE',
      ltp: 145,
      timestamp: START,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
    {
      symbol: 'NSE:NIFTY50-INDEX',
      ltp: 22400,
      timestamp: START + 15000,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
    {
      symbol: 'NSE:NIFTY2412522400CE',
      ltp: 155,
      timestamp: START + 15000,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
    {
      symbol: 'NSE:NIFTY2412522400PE',
      ltp: 148,
      timestamp: START + 15000,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
    {
      symbol: 'NSE:NIFTY50-INDEX',
      ltp: 22400,
      timestamp: START + 30000,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
    {
      symbol: 'NSE:NIFTY2412522400CE',
      ltp: 160,
      timestamp: START + 30000,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
    {
      symbol: 'NSE:NIFTY2412522400PE',
      ltp: 152,
      timestamp: START + 30000,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
    {
      symbol: 'NSE:NIFTY50-INDEX',
      ltp: 22400,
      timestamp: START + 45000,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
    {
      symbol: 'NSE:NIFTY2412522400CE',
      ltp: 165,
      timestamp: START + 45000,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
    {
      symbol: 'NSE:NIFTY2412522400PE',
      ltp: 155,
      timestamp: START + 45000,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
    {
      symbol: 'NSE:NIFTY50-INDEX',
      ltp: 22400,
      timestamp: START + 180000,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: true,
    },
    {
      symbol: 'NSE:NIFTY2412522400CE',
      ltp: 168,
      timestamp: START + 180000,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: true,
    },
    {
      symbol: 'NSE:NIFTY2412522400PE',
      ltp: 157,
      timestamp: START + 180000,
      source: 'fyers-historical',
      resolution: '1',
      gapMarker: false,
    },
  ];

  // Simulate the replay algorithm to compute expected ledger.
  const priceMap = new Map<string, number>();
  const straddleBuffer: number[] = [];
  const rocWindowSize = 5;
  let snapshotCount = 0;
  const expectedSnapshotLedger: Record<string, unknown>[] = [];

  function computeRoc(buf: number[]): number {
    if (buf.length < 2) return 0;
    const prev = buf[buf.length - 2];
    const curr = buf[buf.length - 1];
    if (prev === undefined || curr === undefined || prev === 0) return 0;
    return ((curr - prev) / prev) * 100;
  }

  function computeAcceleration(buf: number[]): number {
    if (buf.length < 3) return 0;
    const a = buf[buf.length - 3];
    const b = buf[buf.length - 2];
    const c = buf[buf.length - 1];
    if (a === undefined || b === undefined || c === undefined) return 0;
    if (a === 0 || b === 0) return 0;
    const rocPrev = ((b - a) / a) * 100;
    const rocCurr = ((c - b) / b) * 100;
    return rocCurr - rocPrev;
  }

  const endMs = START + 180000;
  let virtualNow = START;
  let tickIndex = 0;

  while (tickIndex < syntheticTicks.length || virtualNow <= endMs) {
    // Emit ticks up to virtualNow.
    while (tickIndex < syntheticTicks.length) {
      const tick = syntheticTicks[tickIndex];
      if (tick === undefined || tick.timestamp > virtualNow) break;
      priceMap.set(tick.symbol, tick.ltp);
      tickIndex++;
    }

    // Snapshot step.
    const index = priceMap.get('NSE:NIFTY50-INDEX');
    if (index !== undefined) {
      const atmStrike = Math.round(index / 50) * 50;
      const _ce = priceMap.get(`NSE:NIFTY${24}${1}${25}${atmStrike}CE`);
      const _pe = priceMap.get(`NSE:NIFTY${24}${1}${25}${atmStrike}PE`);
      const ceSymbol = 'NSE:NIFTY2412522400CE';
      const peSymbol = 'NSE:NIFTY2412522400PE';
      const cePrice = priceMap.get(ceSymbol);
      const pePrice = priceMap.get(peSymbol);

      if (cePrice !== undefined && pePrice !== undefined) {
        const sv = cePrice + pePrice;
        straddleBuffer.push(sv);
        if (straddleBuffer.length > rocWindowSize) straddleBuffer.shift();
        const roc = computeRoc(straddleBuffer);
        const acceleration = computeAcceleration(straddleBuffer);
        snapshotCount++;
        expectedSnapshotLedger.push({
          snapshotIndex: snapshotCount - 1,
          virtualTimeMs: virtualNow,
          atmStrike,
          cePrice,
          pePrice,
          straddleValue: sv,
          roc,
          acceleration,
          snapshotCount,
        });
      }
    }

    virtualNow += INTERVAL;
    if (tickIndex >= syntheticTicks.length && virtualNow > endMs + INTERVAL) break;
  }

  const gapMarkerCount = syntheticTicks.filter((t) => t.gapMarker).length;
  const resolutionTags = [...new Set(syntheticTicks.map((t) => t.resolution).filter(Boolean))];

  const fixture = {
    metadata: {
      underlying: UNDERLYING,
      from: new Date(START).toISOString(),
      to: new Date(endMs).toISOString(),
      tickCount: syntheticTicks.length,
      gapMarkerCount,
      resolutionTags,
      snapshotIntervalMs: INTERVAL,
      _frozen: true,
      _version: 1,
      _comment:
        'FROZEN — do not edit without re-running scripts/replay.ts --regenerate-fixture. See README.md.',
    },
    ticks: syntheticTicks,
    expectedSnapshotLedger,
  };

  const fixturePath = join(
    import.meta.dirname,
    '../src/ingestion/historical/__tests__/fixtures/golden/fixture.json',
  );

  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  console.log(`[replay] Fixture written to ${fixturePath}`);
  console.log(`[replay] ${expectedSnapshotLedger.length} snapshot entries in ledger`);
  console.log('[replay] IMPORTANT: review the new fixture before committing.');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  console.error('[replay] Fatal error:', err);
  process.exit(1);
});
