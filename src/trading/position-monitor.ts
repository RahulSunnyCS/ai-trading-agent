/**
 * PositionMonitor — subscribes to the straddle.values Redis stream and manages
 * open short-straddle positions in real time.
 *
 * Responsibilities on each stream snapshot:
 *   1. Load today's open positions from the database.
 *   2. Update the trailing stop watermark for each position.
 *   3. Persist the updated lowestStraddleValueSeen to the DB.
 *   4. Evaluate all exit triggers (SL, TSL, TARGET, EOD, EXIT_WINDOW, DAILY_LOSS).
 *   5. Close any position whose trigger fires via PaperTradeExecutor.
 *   6. ACK the Redis message only after all processing is complete.
 *
 * Stale-data watchdog (fired every watchdogIntervalMs = 5000 ms via clock.tick):
 *   - Warns when the straddle feed has not updated within staleThresholdMs.
 *   - Evaluates time-based exits (EOD, EXIT_WINDOW) using the last known value
 *     so positions are not left dangling if the feed is interrupted near EOD.
 *
 * Entry bridge (optional):
 *   - If an EntryEngine is provided, the monitor registers an 'entry' handler
 *     that calls executor.openTrade() and emits a 'trade-opened' event.
 *
 * Design decisions:
 *   - Uses the ClockWithTick intersection type (same pattern as straddle-calc.ts
 *     and vix-feed.ts) instead of extending the Clock interface — this lets
 *     VirtualClock drive the watchdog in tests without touching clock.ts.
 *   - The watchdog uses clock.tick() not setInterval() so the same VirtualClock
 *     can control both stale detection and the advance of simulated time in tests.
 *   - ACK happens AFTER all DB writes complete so a partial failure (e.g. DB
 *     write succeeds but close fails) leaves the message unACKed and recoverable.
 *   - The in-flight-handler fence (this._inFlight) lets stop() wait for the
 *     current snapshot handler to finish before tearing down, preventing
 *     half-written DB state on shutdown.
 *   - todayNetPnl placeholder: getOpenTrades() returns '0' for todayNetPnl
 *     because it does not know the current straddle value at query time. We do
 *     not attempt to compute a "real" running P&L here because the trigger engine
 *     only uses todayNetPnl for the DAILY_LOSS check, which is an account-level
 *     cumulative figure that would require summing closed-trade P&L plus the
 *     current mark-to-market. For MVP Phase 1, '0' disables the DAILY_LOSS
 *     trigger (the condition is `todayNetPnl <= -maxDailyLoss`; 0 never fires
 *     unless maxDailyLoss is 0). This is an accepted limitation documented in
 *     the P1 risk manifest.
 */

import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { STREAM_STRADDLE, recoverPending, streamConsume } from "../redis/client.js";
import type { ClockWithTick } from "../utils/clock.js";
import type { EntryIntent } from "./entry-engine.js";
import type { EntryEngine } from "./entry-engine.js";
import type { PaperTradeExecutor } from "./paper-trade-executor.js";
import { getOpenTrades } from "./paper-trade-executor.js";
import { evaluateTriggers, updateTrailingStop } from "./trigger-engine.js";
import type { TriggerConfig } from "./trigger-engine.js";

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface PositionMonitorOptions {
  clock: ClockWithTick;
  db: Pool;
  redis: Redis;
  executor: PaperTradeExecutor;
  triggerConfig: TriggerConfig;
  /**
   * How long (ms) the straddle feed must be silent before the watchdog logs a
   * WARN and evaluates time-based exits. Defaults to 30 000 ms (30 seconds).
   */
  staleThresholdMs?: number;
  /**
   * Optional entry engine. When provided, the monitor bridges entry signals to
   * the executor (openTrade) and emits 'trade-opened' events.
   */
  entryEngine?: EntryEngine;
}

// ---------------------------------------------------------------------------
// Event handler types
// ---------------------------------------------------------------------------

type PositionMonitorEvents = {
  /** Emitted after a new paper trade is successfully opened via the entry bridge. */
  "trade-opened": (tradeId: string, intent: EntryIntent) => void;
};

// ---------------------------------------------------------------------------
// PositionMonitor
// ---------------------------------------------------------------------------

export class PositionMonitor {
  private readonly _clock: ClockWithTick;
  private readonly _db: Pool;
  private readonly _redis: Redis;
  private readonly _executor: PaperTradeExecutor;
  private readonly _triggerConfig: TriggerConfig;
  private readonly _staleThresholdMs: number;

  /** Consumer name used for XREADGROUP. Unique per process so multiple instances
   *  can run in parallel without competing for the same pending-message claims.
   *  Using the PID is a simple uniqueness strategy for a single-server MVP. */
  private readonly _consumerName: string;

  /** Shutdown flag set by stop(). The stream handler checks this to skip
   *  processing after a graceful shutdown has been requested. */
  private _stopped = false;

  /** The last epoch-ms at which a real straddle snapshot arrived via the stream.
   *  Initialised to clock.now() at construction so the watchdog does not
   *  immediately fire before the first message arrives. */
  private _lastTickTimestamp: number;

  /** The most recent straddle value from the stream, for watchdog use when
   *  the feed is stale and we need to evaluate EOD/EXIT_WINDOW exits. */
  private _lastKnownStraddleValue: string | null = null;

  /** A promise representing the currently running snapshot handler, or null
   *  when idle. stop() awaits this to ensure graceful completion. */
  private _inFlight: Promise<void> | null = null;

  /** Lightweight hand-rolled event registry (same pattern as EntryEngine). */
  private readonly _handlers: Map<
    keyof PositionMonitorEvents,
    Array<PositionMonitorEvents[keyof PositionMonitorEvents]>
  > = new Map();

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(opts: PositionMonitorOptions) {
    this._clock = opts.clock;
    this._db = opts.db;
    this._redis = opts.redis;
    this._executor = opts.executor;
    this._triggerConfig = opts.triggerConfig;
    this._staleThresholdMs = opts.staleThresholdMs ?? 30_000;

    // Initialise lastTickTimestamp so the watchdog does not fire at t=0.
    this._lastTickTimestamp = this._clock.now();

    // Consumer name is unique per PID to allow multiple monitor instances
    // (e.g. in tests or future multi-process setups) without competing for
    // the same pending-message ownership in Redis.
    this._consumerName = `position-monitor-${process.pid}`;

    // Register the watchdog with the clock's tick mechanism.
    // The watchdog interval is fixed at 5 000 ms (5 seconds) as per the spec.
    const watchdogIntervalMs = 5_000;
    this._clock.tick(watchdogIntervalMs, () => {
      // Skip watchdog work after stop() has been called — avoids a race where
      // the clock fires one more tick after graceful shutdown begins.
      if (this._stopped) return;
      this._runWatchdog();
    });

    // If an entry engine is provided, wire up the entry → openTrade bridge.
    if (opts.entryEngine) {
      opts.entryEngine.on("entry", (intent: EntryIntent) => {
        if (this._stopped) return;
        // Fire-and-forget: errors are caught inside the handler so the entry
        // engine's event emit cannot throw back to the caller.
        this._handleEntryIntent(intent).catch((err: unknown) => {
          console.error("[position-monitor] Entry bridge handler error:", err);
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Recover stale pending messages from a previous consumer, then start the
   * live stream consumption loop.
   *
   * recoverPending() runs BEFORE streamConsume() so that messages that were
   * delivered to a previous process instance but never ACKed are reclaimed by
   * this consumer and reprocessed. This satisfies the "replay idempotency"
   * requirement: we check inside the snapshot handler whether positions are
   * already closed before doing any work.
   */
  async start(): Promise<void> {
    this._stopped = false;

    // Reclaim any pending messages from prior consumers (crash recovery).
    // We log how many were recovered but do not replay their payloads here —
    // streamConsume's XREADGROUP will deliver them in-order as pending messages
    // become visible to the new consumer after XAUTOCLAIM transfers ownership.
    const recovered = await recoverPending(STREAM_STRADDLE, "position-monitor", this._consumerName);
    if (recovered.length > 0) {
      console.info(
        `[position-monitor] Recovered ${recovered.length} pending message(s) from prior consumer`,
      );
    }

    // Start the live consumption loop. The handler wraps each snapshot in an
    // async IIFE stored in this._inFlight so stop() can await graceful finish.
    streamConsume(
      STREAM_STRADDLE,
      "position-monitor",
      this._consumerName,
      async (id: string, fields: Record<string, string>) => {
        if (this._stopped) return;

        // Serialise handlers: wait for the previous one to finish before
        // starting the next. This avoids parallel DB writes that could
        // create race conditions when multiple snapshots arrive in a burst.
        const handlerPromise = (this._inFlight ?? Promise.resolve()).then(() =>
          this._handleSnapshot(fields),
        );
        this._inFlight = handlerPromise;

        // Await the handler so streamConsume only ACKs after completion.
        // (streamConsume ACKs the message after this async handler resolves.)
        await handlerPromise;
      },
    );
  }

  /**
   * Graceful shutdown: signal the loop to stop and wait for any in-flight
   * snapshot handler to complete before returning.
   */
  async stop(): Promise<void> {
    this._stopped = true;
    // Wait for the last snapshot handler to complete so we do not leave
    // partial DB writes when the process shuts down.
    if (this._inFlight) {
      await this._inFlight;
    }
  }

  // ---------------------------------------------------------------------------
  // Event registration (fluent, mirroring EntryEngine.on())
  // ---------------------------------------------------------------------------

  on(event: "trade-opened", handler: (tradeId: string, intent: EntryIntent) => void): this {
    const existing = this._handlers.get(event) ?? [];
    existing.push(handler);
    this._handlers.set(event, existing);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Core: snapshot handler
  // ---------------------------------------------------------------------------

  /**
   * Process one straddle snapshot message from the Redis stream.
   *
   * Steps:
   *   a. Idempotency check — skip if no open positions exist (all already closed).
   *   b. Update lastTickTimestamp and lastKnownStraddleValue for watchdog.
   *   c. For each open position: update trailing stop, persist to DB, evaluate
   *      triggers, close if triggered.
   */
  private async _handleSnapshot(fields: Record<string, string>): Promise<void> {
    // Accept both camelCase and snake_case field names — straddle-calc may
    // publish under either convention depending on the code version.
    const straddleValue = fields.straddleValue ?? fields.straddle_value ?? "";

    if (straddleValue === "") {
      console.warn("[position-monitor] Received snapshot with missing straddleValue — skipping");
      return;
    }

    // --- Step a: Idempotency / replay guard ---
    // Load today's open positions. If all are already closed (empty list), ACK
    // immediately and do nothing. This handles replayed messages from crash
    // recovery: once a position is closed, reprocessing the same snapshot is
    // a no-op. The ACK happens in streamConsume after this function returns.
    const today = this._clock.today();
    const openPositions = await getOpenTrades(this._db, today);

    if (openPositions.length === 0) {
      // No open positions — nothing to do. ACK is issued by streamConsume.
      return;
    }

    // --- Step b: Update in-memory state for watchdog ---
    this._lastTickTimestamp = this._clock.now();
    this._lastKnownStraddleValue = straddleValue;

    // --- Step c: Per-position trailing stop + trigger evaluation ---
    for (const position of openPositions) {
      // Compute the new trailing stop watermark (pure, no async).
      const newLowest = updateTrailingStop(position, straddleValue);

      // Persist the updated watermark to DB immediately so a crash between
      // this write and the trigger evaluation cannot lose the trailing stop
      // data. We use a parameterised query (not string interpolation) to
      // prevent SQL injection, even though lowestStraddleValueSeen comes from
      // the Decimal library (never user input) — defence in depth.
      await this._db.query(
        "UPDATE paper_trades SET lowest_straddle_value_seen = $1 WHERE id = $2",
        [newLowest, position.id],
      );

      // Rebuild the position with the updated lowestStraddleValueSeen for the
      // trigger evaluation. We must use the freshly computed value, not the
      // stale one from the DB query (which may already be one snapshot old).
      const updatedPosition = {
        ...position,
        lowestStraddleValueSeen: newLowest,
      };

      // Evaluate all exit triggers (pure function — no I/O).
      const decision = evaluateTriggers(
        updatedPosition,
        straddleValue,
        this._clock,
        this._triggerConfig,
      );

      if (decision.shouldExit) {
        // Delegate the actual close to the executor, which writes the DB row
        // and notifies Quantiply. Errors from closeTrade propagate up and
        // prevent the ACK (message stays pending for recovery).
        await this._executor.closeTrade(position.id, straddleValue, decision.reason, this._clock);

        console.info(
          `[position-monitor] Closed trade ${position.id} — reason: ${decision.reason} ` +
            `@ straddleValue=${straddleValue}`,
        );
      }
    }

    // ACK is issued by streamConsume after this handler resolves without throwing.
  }

  // ---------------------------------------------------------------------------
  // Watchdog
  // ---------------------------------------------------------------------------

  /**
   * Called every watchdogIntervalMs (5 s) by clock.tick().
   *
   * If the straddle feed has been silent for longer than staleThresholdMs:
   *   1. Log a WARN with how long it has been stale.
   *   2. Evaluate time-based exits (EOD, EXIT_WINDOW) for every open position
   *      using the last known straddle value, and close any that trigger.
   *
   * Using the last known straddle value for time-based exits is acceptable
   * because EOD / EXIT_WINDOW exits are driven entirely by the clock, not by
   * price — the exact straddle value used for the P&L calculation will be the
   * last market price, which is the best we can do without a live feed.
   */
  private _runWatchdog(): void {
    const nowMs = this._clock.now();
    const staleDurationMs = nowMs - this._lastTickTimestamp;

    if (staleDurationMs <= this._staleThresholdMs) {
      // Feed is healthy — nothing to do.
      return;
    }

    const staleSecs = Math.floor(staleDurationMs / 1000);
    console.warn(`[position-monitor] Straddle feed stale for ${staleSecs}s`);

    // Only evaluate time-based exits if we have a last known price.
    // We cannot compute P&L without any straddle value.
    if (this._lastKnownStraddleValue === null) {
      return;
    }

    const lastKnownValue = this._lastKnownStraddleValue;

    // Load open positions and evaluate time-based exits.
    // The watchdog runs in a sync context (clock.tick callback), so we use
    // a fire-and-forget pattern with explicit error handling.
    const today = this._clock.today();

    getOpenTrades(this._db, today)
      .then(async (positions) => {
        for (const position of positions) {
          const decision = evaluateTriggers(
            position,
            lastKnownValue,
            this._clock,
            this._triggerConfig,
          );

          // Only act on time-based exits in the watchdog.
          // Price-based exits (SL, TSL, TARGET, DAILY_LOSS) should only fire on
          // real tick data — using a stale price for price-based exits could
          // trigger a false exit if the straddle moved significantly while the
          // feed was down. EOD and EXIT_WINDOW are purely clock-driven and safe
          // to evaluate with any non-null straddle value.
          if (
            decision.shouldExit &&
            (decision.reason === "EOD" || decision.reason === "EXIT_WINDOW")
          ) {
            try {
              await this._executor.closeTrade(
                position.id,
                lastKnownValue,
                decision.reason,
                this._clock,
              );
              console.info(
                `[position-monitor] Watchdog closed trade ${position.id} — reason: ${decision.reason}`,
              );
            } catch (err: unknown) {
              console.error(
                `[position-monitor] Watchdog: closeTrade failed for trade ${position.id}:`,
                err,
              );
            }
          }
        }
      })
      .catch((err: unknown) => {
        console.error("[position-monitor] Watchdog: getOpenTrades failed:", err);
      });
  }

  // ---------------------------------------------------------------------------
  // Entry bridge
  // ---------------------------------------------------------------------------

  /**
   * Handles an EntryIntent from the EntryEngine.
   *
   * Calls executor.openTrade() to create the DB record and Quantiply notification,
   * then emits 'trade-opened' on this monitor so downstream subscribers (e.g. a
   * UI websocket relay) are notified.
   *
   * Errors from openTrade() are logged but not rethrown: a failed trade open
   * should not crash the monitor loop or prevent the entry engine from
   * continuing to evaluate subsequent signals.
   */
  private async _handleEntryIntent(intent: EntryIntent): Promise<void> {
    let tradeId: string;
    try {
      tradeId = await this._executor.openTrade(intent);
    } catch (err: unknown) {
      console.error("[position-monitor] Entry bridge: openTrade failed:", err);
      return;
    }

    console.info(
      `[position-monitor] Opened trade ${tradeId} via entry bridge ` +
        `— straddleValue=${intent.straddleValue} atmStrike=${intent.atmStrike}`,
    );

    this._emit("trade-opened", tradeId, intent);
  }

  // ---------------------------------------------------------------------------
  // Internal: emit
  // ---------------------------------------------------------------------------

  /**
   * Invoke all registered handlers for the given event.
   * Errors in individual handlers are caught and logged so one bad handler
   * does not prevent others from receiving the event (consistent with EntryEngine).
   */
  private _emit(event: "trade-opened", tradeId: string, intent: EntryIntent): void {
    const handlers = this._handlers.get(event) ?? [];
    for (const handler of handlers) {
      try {
        (handler as PositionMonitorEvents["trade-opened"])(tradeId, intent);
      } catch (err: unknown) {
        console.error(`[position-monitor] Error in '${event}' handler:`, err);
      }
    }
  }
}
