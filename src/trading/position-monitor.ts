/**
 * PositionMonitor — subscribes to the straddle.values Redis stream and manages
 * open short-straddle positions in real time.
 *
 * Responsibilities on each stream snapshot:
 *   1. Load today's open positions from the database (all personalities).
 *   2. Update the trailing stop watermark for each position.
 *   3. Persist the updated lowestStraddleValueSeen to the DB.
 *   4. Evaluate all exit triggers (SL, TSL, TARGET, EOD, EXIT_WINDOW, DAILY_LOSS)
 *      via the correct ManagementHandler for each position's personality.
 *   5. Close any position whose trigger fires via the handler's closePosition().
 *   6. ACK the Redis message only after all processing is complete.
 *
 * Multi-personality dispatch (added in T-28):
 *   Each open position is dispatched to the ManagementHandler matching the
 *   personality's management_style ('hold' → HolderManager, 'roll' → Adjuster,
 *   'cut_reenter' → Reducer). Personality configs are loaded at startup and
 *   cached for the lifetime of the monitor so every snapshot avoids N+1 DB
 *   queries. Positions with personality_id IS NULL (pre-M2 trades) default to
 *   HolderManager.
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
 *   - Personality config cache: loaded once via _loadPersonalityConfigs() at
 *     start() time. This cache is never invalidated during a session; a restart
 *     is required to pick up personality config changes. This is acceptable for
 *     Phase 1 — personality configs change rarely (via evolution engine, which
 *     only runs EOD) and a daily restart is the normal operational cadence.
 */

import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type { OpenPosition, PersonalityConfig } from "../db/schema.js";
import { STREAM_STRADDLE, recoverPending, streamConsume } from "../redis/client.js";
import type { ClockWithTick } from "../utils/clock.js";
import type { EntryIntent } from "./entry-engine.js";
import type { EntryEngine } from "./entry-engine.js";
import type { ManagementHandler } from "./management/holder.js";
import { HolderManager } from "./management/holder.js";
import { AdjusterManager } from "./management/adjuster.js";
import { ReducerManager } from "./management/reducer.js";
import type { PaperTradeExecutor } from "./paper-trade-executor.js";
import { getOpenTrades } from "./paper-trade-executor.js";
import { updateTrailingStop } from "./trigger-engine.js";
import type { TriggerConfig } from "./trigger-engine.js";

// ---------------------------------------------------------------------------
// Local type: open position extended with personality_id
// ---------------------------------------------------------------------------

/**
 * Extends the shared OpenPosition with the personality_id column from
 * paper_trades. We use a local intersection type rather than modifying
 * the shared OpenPosition interface because other callers of OpenPosition
 * (e.g. trigger-engine.ts) do not need personality_id and we want to keep
 * that interface minimal.
 */
type OpenPositionWithPersonality = OpenPosition & {
  personalityId: string | null;
};

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

  /**
   * Personality config cache keyed by personality_configs.id (UUID string).
   * Loaded once at start() time and never invalidated mid-session.
   * A Map is used instead of a plain object so UUID string keys have O(1) lookup
   * without prototype-chain interference.
   */
  private _personalityCache: Map<string, PersonalityConfig> = new Map();

  /**
   * Singleton ManagementHandler instances. One per style — they are stateless
   * so a single instance handles all positions of that style simultaneously.
   */
  private readonly _holderManager: HolderManager = new HolderManager();
  private readonly _adjusterManager: AdjusterManager = new AdjusterManager();
  private readonly _reducerManager: ReducerManager = new ReducerManager();

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
   * Recover stale pending messages from a previous consumer, load personality
   * configs into the cache, then start the live stream consumption loop.
   *
   * recoverPending() runs BEFORE streamConsume() so that messages that were
   * delivered to a previous process instance but never ACKed are reclaimed by
   * this consumer and reprocessed. This satisfies the "replay idempotency"
   * requirement: we check inside the snapshot handler whether positions are
   * already closed before doing any work.
   *
   * _loadPersonalityConfigs() runs before the stream loop starts so the cache
   * is ready before the first snapshot arrives. Failure to load configs is
   * treated as a fatal startup error — if we cannot read personality configs we
   * cannot dispatch correctly, so we must not silently start in a broken state.
   */
  async start(): Promise<void> {
    this._stopped = false;

    // Load personality configs into cache before processing begins.
    // Any DB error here propagates to the caller (src/index.ts) which will
    // log and exit — better than starting up with a broken config cache.
    await this._loadPersonalityConfigs();

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
  // Personality config cache
  // ---------------------------------------------------------------------------

  /**
   * Loads all active personality configs from the DB and stores them in the
   * cache keyed by id. This replaces any previous cache contents — it is safe
   * to call this at startup even if it was called before.
   *
   * We load ALL personalities (not just active ones) so that positions opened
   * by a personality that was later deactivated can still be managed correctly
   * (we must be able to dispatch to their handler to close them at EOD).
   */
  private async _loadPersonalityConfigs(): Promise<void> {
    const result = await this._db.query<{
      id: string;
      name: string;
      display_name: string;
      group_type: string;
      entry_type: string;
      management_style: string;
      is_frozen: boolean;
      is_active: boolean;
      phase: number;
      params: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, name, display_name, group_type, entry_type, management_style,
              is_frozen, is_active, phase, params, created_at, updated_at
       FROM personality_configs`,
    );

    this._personalityCache.clear();
    for (const row of result.rows) {
      // Map snake_case DB columns to the camelCase TypeScript interface.
      const config: PersonalityConfig = {
        id: row.id,
        name: row.name,
        displayName: row.display_name,
        groupType: row.group_type as PersonalityConfig["groupType"],
        entryType: row.entry_type as PersonalityConfig["entryType"],
        managementStyle: row.management_style as PersonalityConfig["managementStyle"],
        isFrozen: row.is_frozen,
        isActive: row.is_active,
        phase: row.phase,
        params: row.params,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      this._personalityCache.set(row.id, config);
    }

    console.info(
      `[position-monitor] Loaded ${this._personalityCache.size} personality config(s) into cache`,
    );
  }

  // ---------------------------------------------------------------------------
  // Handler dispatch
  // ---------------------------------------------------------------------------

  /**
   * Returns the correct ManagementHandler for a given personality config, or
   * HolderManager as the default when no personality is associated (pre-M2 trade).
   *
   * 'roll'        → AdjusterManager (T-29): not yet implemented; uses HolderManager
   *                 as a temporary stand-in so pre-M2 positions can still be managed.
   * 'cut_reenter' → ReducerManager (T-30): not yet implemented; uses HolderManager
   *                 as a temporary stand-in.
   *
   * The TODO comments below are the handoff points for T-29 and T-30 — when those
   * tasks are implemented, replace the HolderManager fallback with the correct import.
   */
  private _resolveHandler(personality: PersonalityConfig | null): ManagementHandler {
    if (personality === null) {
      // No personality associated (pre-M2 trade created before the personality
      // engine existed). Default to the simplest handler — hold until a trigger.
      return this._holderManager;
    }

    switch (personality.managementStyle) {
      case "hold":
        return this._holderManager;

      case "roll":
        return this._adjusterManager;

      case "cut_reenter":
        return this._reducerManager;
    }
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
   *   c. For each open position: update trailing stop, persist to DB, resolve the
   *      correct ManagementHandler based on personality, evaluate triggers, and
   *      close if triggered.
   */
  private async _handleSnapshot(fields: Record<string, string>): Promise<void> {
    // Accept both camelCase and snake_case field names — straddle-calc may
    // publish under either convention depending on the code version.
    const straddleValue = fields.straddleValue ?? fields.straddle_value ?? "";
    const currentSpot = Number.parseFloat(fields.spot ?? "0");

    if (straddleValue === "") {
      console.warn("[position-monitor] Received snapshot with missing straddleValue — skipping");
      return;
    }

    const currentStraddleNumber = Number.parseFloat(straddleValue);

    // --- Step a: Idempotency / replay guard ---
    // Load today's open positions. If all are already closed (empty list), ACK
    // immediately and do nothing. This handles replayed messages from crash
    // recovery: once a position is closed, reprocessing the same snapshot is
    // a no-op. The ACK happens in streamConsume after this function returns.
    const today = this._clock.today();
    const openPositions = await this._getOpenPositionsWithPersonality(today);

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
      const updatedPosition: OpenPositionWithPersonality = {
        ...position,
        lowestStraddleValueSeen: newLowest,
      };

      // Resolve the correct personality config (null for pre-M2 trades).
      const personality =
        updatedPosition.personalityId !== null
          ? (this._personalityCache.get(updatedPosition.personalityId) ?? null)
          : null;

      // If a personalityId is set but we couldn't find it in the cache, that
      // means a personality was created after this monitor started. Log a warning
      // and fall back to HolderManager rather than skipping the position entirely.
      if (updatedPosition.personalityId !== null && personality === null) {
        console.warn(
          `[position-monitor] Unknown personality_id ${updatedPosition.personalityId} for trade ${updatedPosition.id} — falling back to HolderManager`,
        );
      }

      // Resolve the handler and evaluate the exit decision.
      const handler = this._resolveHandler(personality);

      const decision = await handler.evaluatePosition(
        updatedPosition,
        currentStraddleNumber,
        currentSpot,
        this._clock,
        this._triggerConfig,
        this._db,
        // Pass a synthetic default PersonalityConfig when personality is null
        // (pre-M2 trade). The HolderManager ignores the personality parameter
        // so passing a minimal object avoids a null check in the interface.
        personality ?? this._defaultPersonality(),
      );

      if (decision.shouldExit && decision.exitReason !== undefined) {
        // Delegate the actual close to the handler's closePosition(), which
        // writes the DB row and notifies Quantiply via the executor. Errors
        // propagate up and prevent the ACK (message stays pending for recovery).
        await handler.closePosition(
          updatedPosition,
          currentStraddleNumber,
          decision.exitReason,
          this._db,
          this._clock,
          this._executor,
        );

        console.info(
          `[position-monitor] Closed trade ${updatedPosition.id} — reason: ${decision.exitReason} ` +
            `@ straddleValue=${straddleValue}`,
        );
      }
    }

    // ACK is issued by streamConsume after this handler resolves without throwing.
  }

  // ---------------------------------------------------------------------------
  // Query: open positions with personality_id
  // ---------------------------------------------------------------------------

  /**
   * Queries today's open positions, also fetching the personality_id from the
   * paper_trades row so the monitor can dispatch to the correct handler.
   *
   * This is a local query rather than a modification to getOpenTrades() because
   * the shared getOpenTrades() is used by other callers (entry engine, API) that
   * do not need personality_id and should not be coupled to this concern.
   *
   * The time-zone cast (AT TIME ZONE 'Asia/Kolkata') mirrors the logic in
   * getOpenTrades() — see paper-trade-executor.ts for the full rationale.
   * A time-range filter is always included (acceptance criterion 9 equivalent)
   * to avoid full-table scans on paper_trades as the dataset grows.
   */
  private async _getOpenPositionsWithPersonality(
    tradingDate: string,
  ): Promise<OpenPositionWithPersonality[]> {
    const result = await this._db.query<{
      id: string;
      straddle_at_entry: string;
      lowest_straddle_value_seen: string;
      entry_time: Date;
      personality_id: string | null;
    }>(
      `SELECT
         id,
         straddle_at_entry,
         lowest_straddle_value_seen,
         entry_time,
         personality_id
       FROM paper_trades
       WHERE status = 'open'
         AND DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $1`,
      [tradingDate],
    );

    return result.rows.map((row) => ({
      id: row.id,
      entryStraddleValue: row.straddle_at_entry,
      lowestStraddleValueSeen: row.lowest_straddle_value_seen,
      entryTimeMs: row.entry_time.getTime(),
      todayNetPnl: "0",
      personalityId: row.personality_id,
    }));
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
   *
   * The watchdog dispatches through the handler system for consistency, but
   * only acts on time-based exits (EOD, EXIT_WINDOW) — price-based exits
   * should only fire on real tick data (see the filter below).
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
    const lastKnownNumber = Number.parseFloat(lastKnownValue);

    // Load open positions and evaluate time-based exits.
    // The watchdog runs in a sync context (clock.tick callback), so we use
    // a fire-and-forget pattern with explicit error handling.
    const today = this._clock.today();

    this._getOpenPositionsWithPersonality(today)
      .then(async (positions) => {
        for (const position of positions) {
          const personality =
            position.personalityId !== null
              ? (this._personalityCache.get(position.personalityId) ?? null)
              : null;

          const handler = this._resolveHandler(personality);

          const decision = await handler.evaluatePosition(
            position,
            lastKnownNumber,
            0, // spot is unknown in watchdog context — only time-based exits fire
            this._clock,
            this._triggerConfig,
            this._db,
            personality ?? this._defaultPersonality(),
          );

          // Only act on time-based exits in the watchdog.
          // Price-based exits (SL, TSL, TARGET, DAILY_LOSS) should only fire on
          // real tick data — using a stale price for price-based exits could
          // trigger a false exit if the straddle moved significantly while the
          // feed was down. EOD and EXIT_WINDOW are purely clock-driven and safe
          // to evaluate with any non-null straddle value.
          if (
            decision.shouldExit &&
            decision.exitReason !== undefined &&
            (decision.exitReason === "EOD" || decision.exitReason === "EXIT_WINDOW")
          ) {
            try {
              await handler.closePosition(
                position,
                lastKnownNumber,
                decision.exitReason,
                this._db,
                this._clock,
                this._executor,
              );
              console.info(
                `[position-monitor] Watchdog closed trade ${position.id} — reason: ${decision.exitReason}`,
              );
            } catch (err: unknown) {
              console.error(
                `[position-monitor] Watchdog: closePosition failed for trade ${position.id}:`,
                err,
              );
            }
          }
        }
      })
      .catch((err: unknown) => {
        console.error("[position-monitor] Watchdog: _getOpenPositionsWithPersonality failed:", err);
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

  // ---------------------------------------------------------------------------
  // Internal: default personality for pre-M2 trades
  // ---------------------------------------------------------------------------

  /**
   * Returns a synthetic PersonalityConfig used when a trade has no personality_id
   * (pre-M2 trades created before the personality engine was deployed).
   *
   * HolderManager ignores the personality argument entirely (it has no
   * personality-specific params), so the exact values here do not matter.
   * We use management_style 'hold' to make the intent explicit and to ensure
   * that if the personality object is ever inspected in a log, its values
   * are self-documenting.
   *
   * This is NOT inserted into the DB — it is a transient in-memory default used
   * solely to satisfy the ManagementHandler interface's non-null requirement.
   */
  private _defaultPersonality(): PersonalityConfig {
    return {
      id: "00000000-0000-0000-0000-000000000000",
      name: "pre-m2-default",
      displayName: "Pre-M2 Default (Hold)",
      groupType: "reference",
      entryType: "fixed_time",
      managementStyle: "hold",
      isFrozen: false,
      isActive: false,
      phase: 1,
      params: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }
}
