/**
 * StraddleCalculator
 *
 * Subscribes to broker tick events and publishes 15-second ATM straddle
 * snapshots to the Redis stream `straddle.values` and to the PostgreSQL
 * `straddle_snapshots` hypertable.
 *
 * MVP constraint: CE and PE prices are '0' because we only subscribe to the
 * NIFTY spot index tick, not individual option chain ticks. The ATM strike is
 * computed via getAtmStrike() and recorded alongside the spot price so that
 * Phase 2 option-chain subscription can back-fill the prices without a schema
 * change.
 *
 * Time contract: uses Clock.tick() (not setInterval) so that test code using
 * VirtualClock can drive snapshots deterministically without real timers.
 */

import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { STREAM_STRADDLE } from "../redis/client.js";
import type { ClockWithTick } from "../utils/clock.js";
import { getAtmStrike } from "./brokers/instrument-registry.js";
import type { BrokerFeed, BrokerTick } from "./brokers/types.js";

// ---------------------------------------------------------------------------
// StraddleCalculatorConfig
// ---------------------------------------------------------------------------

export interface StraddleCalculatorConfig {
  db: Pool;
  redis: Redis;
  clock: ClockWithTick;
}

// ---------------------------------------------------------------------------
// StraddleCalculator
// ---------------------------------------------------------------------------

/**
 * Calculates and publishes ATM straddle snapshots every STRADDLE_INTERVAL_MS
 * milliseconds.
 *
 * Design decisions:
 *   - Snapshot interval driven by Clock.tick() rather than setInterval so tests
 *     using VirtualClock can trigger snapshots by calling clock.advance().
 *   - Only NIFTY spot ticks (underlying === 'NIFTY' && isIndex === true) update
 *     the last-known spot price. VIX ticks update the last-known VIX. All other
 *     ticks are ignored because we only need these two values for the MVP snapshot.
 *   - The snapshot is published to Redis first, then written to PostgreSQL. If the
 *     DB write fails we log the error but do not crash — Redis is the primary event
 *     bus and downstream consumers already have the snapshot.
 *   - We guard against publishing a snapshot before any NIFTY tick has arrived
 *     (_lastSpot === null). In this case the interval fires but nothing is published.
 */
export class StraddleCalculator {
  private readonly _db: Pool;
  private readonly _redis: Redis;
  private readonly _clock: ClockWithTick;

  /** Interval between published snapshots in milliseconds. */
  private readonly _intervalMs: number;

  /** The most recent NIFTY spot price seen from the broker. Null until first tick. */
  private _lastSpot: number | null = null;

  /** The most recent India VIX value seen. Null until first VIX tick. */
  private _lastVix: number | null = null;

  /** Whether the calculator is actively running. */
  private _running = false;

  // --------------------------------------------------------------------------
  // OI tracking fields
  //
  // These fields track the call and put open interest for the ATM straddle so
  // that PeakDetectionEngine can read the OI change from Redis as a context
  // signal. In SIMULATE mode, no option ticks arrive so all four remain null —
  // downstream code handles null gracefully (OI adjustment treated as 0).
  // --------------------------------------------------------------------------

  /** Call-side OI at the 9:15–9:30 AM open window (locked once on first snapshot). */
  private _openCallOi: number | null = null;
  /** Put-side OI at the 9:15–9:30 AM open window (locked once on first snapshot). */
  private _openPutOi: number | null = null;
  /** Most recent call OI received from an option tick. */
  private _lastCallOi: number | null = null;
  /** Most recent put OI received from an option tick. */
  private _lastPutOi: number | null = null;
  /** Epoch-ms at which the open OI was locked. Used to prevent re-locking. */
  private _oiOpenLockedMs: number | null = null;

  constructor(config: StraddleCalculatorConfig) {
    this._db = config.db;
    this._redis = config.redis;
    this._clock = config.clock;

    // Read interval from env var; default to 15_000 ms (15 seconds).
    // parseInt returns NaN on non-numeric strings; the || fallback handles that.
    const envInterval = Number.parseInt(process.env.STRADDLE_INTERVAL_MS ?? "", 10);
    this._intervalMs = Number.isFinite(envInterval) && envInterval > 0 ? envInterval : 15_000;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Start listening for ticks from the given broker feed and begin the
   * snapshot publication loop.
   *
   * Can only be started once per instance. Calling start() on an already-running
   * calculator is a no-op (guarded by _running flag).
   */
  start(broker: BrokerFeed): void {
    if (this._running) {
      return;
    }
    this._running = true;

    // Register for all broker ticks. We filter to NIFTY spot and VIX inside
    // the handler rather than subscribing to separate symbol lists, because
    // the BrokerFeed tick event delivers all subscribed symbols on one channel.
    broker.on("tick", (tick: BrokerTick) => this._handleTick(tick));

    // Register the periodic snapshot publisher with the clock.
    // VirtualClock will fire this when advance() crosses an interval boundary;
    // RealClock (which also implements tick()) fires on wall-clock time.
    this._clock.tick(this._intervalMs, () => {
      if (!this._running) {
        // Once stop() is called, ignore any residual clock firings.
        // VirtualClock cannot deregister a tick callback after registration,
        // so we guard here instead.
        return;
      }
      // Fire-and-forget; errors are caught and logged inside _publishSnapshot.
      this._publishSnapshot();
    });

    console.log(`[StraddleCalculator] Started — snapshot interval ${this._intervalMs} ms`);
  }

  /**
   * Stop the snapshot publisher.
   *
   * Because VirtualClock has no tick-deregistration API, we set _running = false
   * and guard against firing inside the callback (see the tick handler above).
   * After stop() any in-flight DB/Redis writes still complete normally.
   */
  stop(): void {
    this._running = false;
    console.log("[StraddleCalculator] Stopped");
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  /**
   * Processes a tick from the broker.
   * Updates _lastSpot on NIFTY index ticks, _lastVix on VIX ticks.
   * All other ticks are ignored in the MVP.
   */
  private _handleTick(tick: BrokerTick): void {
    if (tick.isIndex) {
      if (tick.underlying === "NIFTY") {
        this._lastSpot = tick.ltp;
      } else if (tick.underlying === "INDIAVIX") {
        this._lastVix = tick.ltp;
      }
    }

    // Track option OI when option ticks arrive (live Fyers mode only).
    // In SIMULATE mode the simulator emits only index ticks (isIndex=true),
    // so these fields remain null — the downstream OI change key is simply
    // never written to Redis and PeakDetectionEngine gets null (0 adjustment).
    //
    // We do not filter by ATM strike here because we don't know the current
    // ATM strike inside _handleTick without a spot price. Instead we track
    // whichever CE and PE OI arrives most recently and let _publishSnapshot
    // overwrite per interval — the 15-second snapshot cadence means we use
    // the OI of the most recently ticked option (almost always the ATM option
    // in active markets, since ATM sees the highest tick frequency).
    if (!tick.isIndex && tick.optionType !== undefined) {
      if (tick.optionType === "CE") {
        this._lastCallOi = tick.oi;
      } else if (tick.optionType === "PE") {
        this._lastPutOi = tick.oi;
      }
    }
  }

  /**
   * Builds and publishes one snapshot to Redis and PostgreSQL.
   *
   * Skipped silently when no NIFTY spot tick has arrived yet (_lastSpot === null).
   * This prevents publishing a meaningless snapshot at startup.
   *
   * Error handling strategy:
   *   - Redis publish failure: logged as error, execution continues. The snapshot
   *     interval will retry on the next boundary.
   *   - DB write failure: logged as error, execution continues. Redis is the
   *     primary fan-out channel; DB is secondary storage.
   */
  private _publishSnapshot(): void {
    if (this._lastSpot === null) {
      // No spot price yet — skip this interval.
      return;
    }

    const spot = this._lastSpot;
    const vix = this._lastVix;
    const now = this._clock.now();

    // getAtmStrike rounds to the nearest 50-point interval for NIFTY.
    const atmStrike = getAtmStrike("NIFTY", spot);

    // ------------------------------------------------------------------
    // OI tracking: lock open OI once during 9:15–9:30 AM IST and then
    // compute the percentage change for PeakDetectionEngine to read.
    //
    // Why UTC arithmetic instead of toLocaleString?
    // IST = UTC+5:30 (no DST). Adding 330 minutes and reading getUTCHours/
    // getUTCMinutes is ~5x faster than toLocaleString with a timezone and
    // avoids locale-specific formatting edge cases in the Bun runtime.
    // ------------------------------------------------------------------
    this._updateOiTracking(now);

    // Build the Redis stream payload. All numeric values are stringified because
    // Redis Streams only store string field values. The consumer must parse them.
    const fields: Record<string, string> = {
      time: String(now),
      underlying: "NIFTY",
      spot: String(spot),
      atmStrike: String(atmStrike),
      // CE/PE prices are '0' in MVP — no option tick subscription yet.
      cePrice: "0",
      pePrice: "0",
      straddleValue: "0",
      // VIX is null-safe: if not yet received, we publish the literal string
      // 'null' so consumers can distinguish "not received" from "zero".
      vix: vix !== null ? String(vix) : "null",
    };

    // Publish to Redis first (primary fan-out). Use XADD directly on the
    // injected Redis client because streamPublish() from client.ts uses the
    // module-level singleton redis client, not our injected one.
    // Injecting the Redis client allows tests to pass an isolated Redis instance.
    this._publishToRedis(fields, now, spot, atmStrike, vix);
  }

  /**
   * Publishes the snapshot fields to the Redis stream and then to PostgreSQL.
   * Separated from _publishSnapshot to keep the async logic clean — the caller
   * is a sync clock tick callback.
   *
   * We use fire-and-forget at the call site (no await) because the clock tick
   * callback is synchronous. Errors are caught here and logged.
   */
  private _publishToRedis(
    fields: Record<string, string>,
    now: number,
    spot: number,
    atmStrike: number,
    vix: number | null,
  ): void {
    // Flatten fields into the variadic format ioredis expects: [k, v, k, v, ...]
    const flatFields: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      flatFields.push(k, v);
    }

    // Chain Redis publish → DB write in a single promise chain.
    // Using .catch() on each step independently so a Redis failure does not
    // prevent the DB write from being attempted.
    this._redis
      .xadd(STREAM_STRADDLE, "MAXLEN", "~", "10000", "*", ...flatFields)
      .catch((err: unknown) => {
        console.error("[StraddleCalculator] Redis publish error:", err);
      })
      .then(() => {
        // Write to PostgreSQL regardless of whether Redis succeeded.
        // The DB row is the durable record; Redis is the real-time fan-out.
        return this._writeToDb(now, spot, atmStrike, vix);
      })
      .catch((err: unknown) => {
        console.error("[StraddleCalculator] DB write error:", err);
      });
  }

  /**
   * Locks the open OI at the first snapshot during the 9:15–9:30 AM IST window
   * and then writes the current OI change percentage to Redis.
   *
   * This is a private helper called from _publishSnapshot so that the OI logic
   * does not clutter the main snapshot publication path.
   *
   * The Redis write is fire-and-forget (.catch(() => {})) because OI is
   * supplemental data — a Redis write failure must never prevent snapshot
   * publication or crash the process. The key expires after 900 seconds (15
   * minutes) which is long enough to survive any Redis hiccup during a trading
   * session but prevents stale OI data from persisting across sessions.
   */
  private _updateOiTracking(now: number): void {
    // IST = UTC + 5h30m = UTC + 330 minutes. No DST in IST, so the offset is fixed.
    const IST_OFFSET_MS = 330 * 60 * 1000;
    const istDate = new Date(now + IST_OFFSET_MS);
    const istHour = istDate.getUTCHours();
    const istMin = istDate.getUTCMinutes();
    // 9:15–9:30 AM IST is the opening window for ATM straddle OI.
    const isOpenWindow = istHour === 9 && istMin >= 15 && istMin <= 30;

    // Lock the open OI exactly once: on the first snapshot that arrives during
    // the open window with both CE and PE OI values available.
    if (
      isOpenWindow &&
      this._oiOpenLockedMs === null &&
      this._lastCallOi !== null &&
      this._lastPutOi !== null
    ) {
      this._openCallOi = this._lastCallOi;
      this._openPutOi = this._lastPutOi;
      this._oiOpenLockedMs = now;
    }

    // Publish OI change to Redis only when we have a valid baseline and current values.
    if (
      this._openCallOi !== null &&
      this._openPutOi !== null &&
      this._lastCallOi !== null &&
      this._lastPutOi !== null &&
      this._openCallOi + this._openPutOi > 0 // Guard against divide-by-zero
    ) {
      const currentOi = this._lastCallOi + this._lastPutOi;
      const openOi = this._openCallOi + this._openPutOi;
      const oiChangePct = ((currentOi - openOi) / openOi) * 100;

      // Fire-and-forget: OI is supplemental. A Redis write failure here must
      // not crash the snapshot loop or bubble up to the caller.
      this._redis
        .set("straddle_oi_change:NIFTY", String(oiChangePct), "EX", 900)
        .catch(() => {
          // Intentionally silent — errors are not logged to avoid noise on
          // transient Redis blips. The next snapshot will retry.
        });
    }
  }

  /**
   * Inserts one straddle snapshot row into the `straddle_snapshots` hypertable.
   *
   * Uses parameterised queries (never string interpolation) to prevent SQL
   * injection. The straddle_snapshots table is a TimescaleDB hypertable —
   * always include the `time` column in queries so TimescaleDB can route to the
   * correct chunk efficiently.
   *
   * NUMERIC columns (spot, atm_strike, ce_price, pe_price, straddle_value, vix)
   * accept string literals in PostgreSQL — the driver passes our string values
   * unchanged and PostgreSQL coerces them to NUMERIC. This is intentional per the
   * project convention (no ORM, NUMERIC as strings).
   */
  private async _writeToDb(
    nowMs: number,
    spot: number,
    atmStrike: number,
    vix: number | null,
  ): Promise<void> {
    const sql = `
      INSERT INTO straddle_snapshots
        (time, underlying, spot, atm_strike, ce_price, pe_price, straddle_value, vix)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT DO NOTHING
    `;

    // Convert epoch-ms to a JS Date so pg serialises it as a proper timestamp.
    const time = new Date(nowMs);

    await this._db.query(sql, [
      time,
      "NIFTY",
      String(spot),
      String(atmStrike),
      "0", // cePrice — MVP placeholder
      "0", // pePrice — MVP placeholder
      "0", // straddleValue — MVP placeholder
      vix !== null ? String(vix) : null, // null preserved as SQL NULL
    ]);
  }
}
