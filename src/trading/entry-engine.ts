/**
 * Entry engine — evaluates whether a new straddle entry should be placed.
 *
 * This engine subscribes to the `straddle.values` Redis stream. On each
 * snapshot it evaluates a set of gate conditions (time window, blocked dates,
 * open-position check, and optional VIX cap). When all gates pass it emits an
 * EntryIntent event. It does NOT execute the trade itself — that is delegated
 * to the position monitor / paper-trade executor.
 *
 * Design choices:
 * - EventEmitter pattern instead of callbacks: keeps the public API idiomatic
 *   for Node/Bun and consistent with how the trigger engine exposes decisions.
 * - All gate logic is synchronous where possible; the DB query is the only
 *   async step per snapshot. This keeps latency low on the hot path.
 * - The 5-minute cooldown is tracked in memory (not Redis/DB) because the
 *   entry engine is a singleton process; a restart naturally resets the cooldown,
 *   which is acceptable for a research paper-trading tool.
 */

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { query } from '../db/client.js';
import { STREAM_STRADDLE, streamConsume } from '../redis/client.js';
import type { Clock } from '../utils/clock.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The data payload emitted when all entry conditions are met.
 * Receivers (position monitor) use this to open a paper trade.
 *
 * straddleValue and vixAtEntry are strings because all NUMERIC columns
 * flow through the codebase as strings (see src/db/schema.ts comment).
 * atmStrike is an integer (strike prices in points) so a JS number is safe.
 * underlying is fixed to 'NIFTY' for Phase 1 (BankNifty/Sensex in Phase 2).
 * entryTimeMs is epoch-ms so callers can compute time-in-trade without
 * instantiating a Date object.
 */
export interface EntryIntent {
  straddleValue: string;
  atmStrike: number;
  underlying: 'NIFTY';
  spot: string;
  vixAtEntry: string | null;
  entryTimeMs: number;
}

// Narrow event map so TypeScript can type-check handler signatures.
type EntryEngineEvents = {
  entry: (intent: EntryIntent) => void;
};

// ---------------------------------------------------------------------------
// Entry engine
// ---------------------------------------------------------------------------

export class EntryEngine {
  private readonly _db: Pool;
  private readonly _clock: Clock;

  // Event handler registry — a lightweight hand-rolled emitter so we avoid
  // pulling in EventEmitter (which would require a .js import shim under ESM
  // strict mode in Bun) while still satisfying the `on()` contract in the spec.
  private readonly _handlers: Map<
    keyof EntryEngineEvents,
    Array<EntryEngineEvents[keyof EntryEngineEvents]>
  > = new Map();

  // Tracks the epoch-ms timestamp of the last emitted entry signal.
  // Used to enforce the cooldown period between entries.
  // null = no signal has been emitted yet in this process lifetime.
  private _lastEntryMs: number | null = null;

  // Flag set by stop() so the message handler can skip processing any
  // messages that arrive after a shutdown is requested.
  private _stopped = false;

  // ---------------------------------------------------------------------------
  // Configuration (loaded from env at construction time)
  // ---------------------------------------------------------------------------

  /** Earliest IST time at which an entry is allowed, e.g. '09:20'. */
  private readonly _entryStartTime: string;

  /** Latest IST time at which an entry is allowed, e.g. '14:30'. */
  private readonly _entryCutoffTime: string;

  /**
   * Set of dates (YYYY-MM-DD) on which entries are blocked regardless of
   * all other conditions (RBI policy days, budget days, expiry mornings, etc.).
   */
  private readonly _blockedDates: ReadonlySet<string>;

  /**
   * Optional VIX ceiling. If set, entries are blocked when VIX exceeds this value.
   * null = no VIX gate (default).
   */
  private readonly _vixMax: number | null;

  /**
   * Minimum milliseconds between consecutive entry signals.
   * Default 300 000 ms (5 minutes).
   * Not readonly because the constructor validates and may clamp the parsed value.
   */
  private _cooldownMs: number;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(deps: { db: Pool; redis: Redis; clock: Clock }) {
    this._db = deps.db;
    this._clock = deps.clock;
    // redis is passed in for interface compatibility (streamConsume uses the
    // module-level singleton from src/redis/client.ts, not an injected client).
    // We accept it in the constructor signature per the task contract but do
    // not store it — callers that inject a test Redis client are intentionally
    // NOT supported at the streamConsume level; that layer is tested separately.

    this._entryStartTime = process.env.ENTRY_START_TIME ?? '09:20';
    this._entryCutoffTime = process.env.ENTRY_CUTOFF_TIME ?? '14:30';

    // BLOCKED_DATES is a JSON array of 'YYYY-MM-DD' strings.
    // We parse it once and store it as a Set for O(1) lookups.
    // Invalid JSON defaults to an empty set rather than crashing — a mis-set
    // env var should not prevent the engine from starting.
    const rawBlocked = process.env.BLOCKED_DATES ?? '[]';
    let parsedBlocked: string[] = [];
    try {
      const parsed = JSON.parse(rawBlocked);
      if (Array.isArray(parsed)) {
        parsedBlocked = parsed.filter((d): d is string => typeof d === 'string');
      }
    } catch {
      console.warn('[entry-engine] BLOCKED_DATES is not valid JSON; defaulting to empty list');
    }
    this._blockedDates = new Set(parsedBlocked);

    // VIX_MAX is optional. When absent (or non-numeric), the gate is disabled.
    const rawVixMax = process.env.VIX_MAX;
    if (rawVixMax !== undefined) {
      const parsed = Number.parseFloat(rawVixMax);
      this._vixMax = Number.isFinite(parsed) ? parsed : null;
    } else {
      this._vixMax = null;
    }

    const parsedCooldown = Number.parseInt(process.env.ENTRY_COOLDOWN_MS ?? '300000', 10);
    // Guard against an env var that parses to NaN or a negative value —
    // fall back to the 5-minute default. parseInt("abc") = NaN, which is not finite.
    this._cooldownMs =
      Number.isFinite(parsedCooldown) && parsedCooldown >= 0 ? parsedCooldown : 300_000;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Begin consuming the straddle.values Redis stream.
   *
   * Uses consumer group 'entry-engine' / consumer name 'primary'.
   * Each message is processed, gated, and ACKed via streamConsume's built-in
   * ACK-after-handler semantics.
   *
   * Returns immediately — the consume loop runs asynchronously.
   */
  start(): void {
    this._stopped = false;

    streamConsume(
      STREAM_STRADDLE,
      'entry-engine',
      'primary',
      async (_id: string, fields: Record<string, string>) => {
        // If stop() was called between when the message was delivered and when
        // the handler executes, discard the message without emitting.
        if (this._stopped) return;

        await this._handleSnapshot(fields);
      },
    );
  }

  /**
   * Signal the engine to stop processing new messages.
   *
   * The underlying streamConsume loop is managed by the global shutdown flag
   * in src/redis/client.ts (closeRedis). Here we set a local flag so that any
   * messages still in flight after stop() are silently discarded rather than
   * potentially emitting a spurious entry intent during shutdown.
   */
  stop(): void {
    this._stopped = true;
  }

  // ---------------------------------------------------------------------------
  // Event registration (fluent)
  // ---------------------------------------------------------------------------

  /**
   * Register a handler for the 'entry' event.
   * Returns `this` for method chaining, mirroring the EventEmitter API.
   */
  on(event: 'entry', handler: (intent: EntryIntent) => void): this {
    const existing = this._handlers.get(event) ?? [];
    existing.push(handler);
    this._handlers.set(event, existing);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Core: snapshot handler
  // ---------------------------------------------------------------------------

  /**
   * Evaluates all entry gate conditions for a single straddle snapshot.
   * Emits an EntryIntent if every gate passes.
   *
   * Gate order matches the task contract (a, b, c, d) but is also ordered by
   * cost: the two cheapest synchronous checks (time gate, blocked-date gate)
   * are first so we skip the DB query if they fail.
   */
  private async _handleSnapshot(fields: Record<string, string>): Promise<void> {
    const nowMs = this._clock.now();

    // --- Gate a: time window ---
    // Convert the current clock instant to IST 'HH:mm:ss' then take HH:MM
    // for comparison. Lexicographic string comparison works correctly for
    // zero-padded time strings within the same day.
    const nowHHMM = this._clock.toISTTime(nowMs).slice(0, 5);
    if (nowHHMM < this._entryStartTime || nowHHMM >= this._entryCutoffTime) {
      // Outside the entry window — skip silently (very common during off-hours).
      return;
    }

    // --- Gate b: blocked dates ---
    const todayDate = this._clock.today();
    if (this._blockedDates.has(todayDate)) {
      console.info(`[entry-engine] Skipping entry: ${todayDate} is a blocked date`);
      return;
    }

    // --- Gate c: no existing open positions ---
    // We query paper_trades here rather than caching state because the position
    // monitor (a separate module) writes trades to DB. Querying is the only safe
    // way to get ground truth; an in-memory cache here would be a race condition.
    const openTrades = await query<{ id: string }>(
      'SELECT id FROM paper_trades WHERE status = $1 LIMIT 1',
      ['open'],
    );
    if (openTrades.length > 0) {
      // An open position exists — no new entry until it is closed.
      return;
    }

    // --- Gate d: VIX ceiling ---
    // VIX is optional in the snapshot (not always available at startup).
    // We only block if VIX_MAX is configured AND the snapshot carries a VIX value.
    // Missing VIX = gate passes (do not penalise for unavailable data).
    const rawVix = fields.vix;
    const vixValue = rawVix !== undefined && rawVix !== '' ? Number.parseFloat(rawVix) : null;

    if (this._vixMax !== null && vixValue !== null && vixValue > this._vixMax) {
      console.info(`[entry-engine] Skipping entry: VIX ${vixValue} > VIX_MAX ${this._vixMax}`);
      return;
    }

    // --- Cooldown throttle ---
    // Prevent firing multiple entries within the cooldown window. This is a
    // safety net for edge cases where multiple straddle snapshots arrive close
    // together while all gates are simultaneously open.
    if (this._lastEntryMs !== null && nowMs - this._lastEntryMs < this._cooldownMs) {
      return;
    }

    // --- All gates passed — build and emit the EntryIntent ---
    // Accept both camelCase and snake_case field names because the straddle
    // calculator may publish under either convention depending on when it was
    // written. The camelCase key is checked first (preferred going forward).
    const straddleValue = fields.straddleValue ?? fields.straddle_value ?? '';
    const rawAtmStrike = fields.atmStrike ?? fields.atm_strike ?? '0';
    const atmStrike = Number.parseInt(rawAtmStrike, 10);
    const spot = fields.spot ?? '0';

    // straddleValue must be a non-empty numeric string — if the snapshot is
    // malformed we log and skip rather than emitting a bad intent.
    if (straddleValue === '') {
      console.warn('[entry-engine] Received snapshot with missing straddleValue — skipping');
      return;
    }

    const intent: EntryIntent = {
      straddleValue,
      atmStrike,
      // Phase 1 only supports NIFTY. BankNifty/Sensex are Phase 2.
      underlying: 'NIFTY',
      spot,
      // vixAtEntry is null when VIX data is unavailable, matching the DB
      // column's nullable constraint (paper_trades.vix_at_entry).
      vixAtEntry: vixValue !== null ? String(vixValue) : null,
      entryTimeMs: nowMs,
    };

    // Update the cooldown timestamp BEFORE emitting so that a synchronous
    // handler cannot re-enter this path within the same tick.
    this._lastEntryMs = nowMs;

    this._emit('entry', intent);
  }

  // ---------------------------------------------------------------------------
  // Internal: emit
  // ---------------------------------------------------------------------------

  /**
   * Invoke all registered handlers for the given event.
   * Errors in individual handlers are caught and logged so one bad handler
   * does not prevent others from receiving the event.
   */
  private _emit(event: 'entry', intent: EntryIntent): void {
    const handlers = this._handlers.get(event) ?? [];
    for (const handler of handlers) {
      try {
        (handler as EntryEngineEvents['entry'])(intent);
      } catch (err: unknown) {
        console.error(`[entry-engine] Error in '${event}' handler:`, err);
      }
    }
  }
}
