/**
 * personality-router.ts — Personality Router
 *
 * Consumes signals from the `signals.generated` Redis stream and fans each
 * signal out to ALL active personalities in parallel, applying the 5-stage
 * filter independently for each personality.
 *
 * Design decisions:
 * - Consumer group: 'personality-router' / consumer: 'primary'.
 *   This is a single-consumer group: the router is a singleton process that
 *   owns all signals. Multiple consumers within the same group would partition
 *   signals (XREADGROUP semantics), which would break the "fan-out to ALL
 *   personalities" requirement. To scale horizontally we would need one group
 *   per personality, but that is a Phase 2 concern.
 *
 * - Batch DailyState fetch: we call fetchDailyState once per active personality
 *   in a single Promise.all, not sequentially. With 10 personalities this cuts
 *   the DB round-trip count from N serial queries to 1 parallel batch.
 *   See fetchDailyState docs — it runs two queries per personality; Promise.all
 *   lets those run concurrently across all personalities.
 *
 * - Filter fan-out is Promise.all: runPersonalityFilter is pure (no I/O), so
 *   running 10 in parallel is safe. No lock or serialisation is needed here.
 *
 * - Portfolio serialisation happens AFTER the parallel fan-out. The only
 *   serialised step is "open trade in DB" for each passing personality — this
 *   prevents race conditions where two concurrent INSERT statements both see
 *   0 open positions and both pass a portfolio check before either commits.
 *   We iterate passing personalities sequentially for trade opens.
 *
 * - VIX staleness gate: if the most-recent VIX timestamp is more than
 *   VIX_STALE_MS (env, default 300,000 ms = 5 min) ago, all new trade opens
 *   are blocked. VIX staleness is tracked by recording the epoch-ms of every
 *   signal that carries a non-null VIX value.
 *
 * - openTrade() returns a trade ID. We immediately UPDATE paper_trades to
 *   populate personality_id and signal_id (columns added in migration 004).
 *   This avoids modifying PaperTradeExecutor.openTrade() which does not
 *   currently accept those fields — keeping the executor focused on its own
 *   concern and this module responsible for personality association.
 *
 * - Startup reconciliation: on start() we load all `status='open'` paper trades
 *   from the DB and log them per personality. This is where T-28/T-29/T-30
 *   management handlers will be attached once implemented — for now we log and
 *   continue so the pattern is in place.
 *
 * - IncomingSignal and TradeIntent are exported types consumed by the router
 *   internally and potentially by management handlers (T-28/T-29/T-30).
 */

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { PersonalityConfigM2 as PersonalityConfig } from '../db/schema.js';
import { STREAM_SIGNALS } from '../redis/client.js';
import type { EntryIntent } from '../trading/entry-engine.js';
import { PaperTradeExecutor } from '../trading/paper-trade-executor.js';
import { portfolioRiskCheck } from '../trading/portfolio-risk.js';
import { QuantiplyStub } from '../trading/quantiply-stub.js';
import type { Clock } from '../utils/clock.js';
import {
  type StraddleSignalInput,
  fetchDailyState,
  parseBlockedDatesSet,
  runPersonalityFilter,
} from './personality-filter.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An incoming signal parsed from the `signals.generated` Redis stream.
 *
 * All numeric fields are stored as strings on the stream (Redis stores
 * everything as bytes/strings). The router parses them into numbers before
 * passing to the filter, which expects number types (see StraddleSignalInput).
 * vix is `string | null` — a literal 'null' string from the stream or missing
 * field both map to null here, before numeric parsing.
 *
 * sr_subtype and sr_strength are optional — absent for MOMENTUM_EXHAUSTION and
 * SCHEDULED signals; present when the S/R detection engine (Phase 2) emits an
 * SR_REVERSAL signal. Both are optional in the interface so the type remains
 * compatible with Phase-1-only callers that don't set them.
 */
export interface IncomingSignal {
  signalId: string;
  signal_type: 'MOMENTUM_EXHAUSTION' | 'SCHEDULED' | 'PULLBACK';
  underlying: string;
  atm_strike: number;
  spot: string;
  straddle_value: string;
  vix: string | null;
  adjusted_probability: number;
  confidence_tier: string;
  signal_time: number;
  /** S/R signal sub-type. Present only for S/R signals (Phase 2+). */
  sr_subtype?: 'SR_REVERSAL' | null;
  /**
   * S/R strength score as a raw string from the stream (parsed from the pg
   * NUMERIC column). The router parses this to a number before passing to
   * the filter. Optional — absent for non-S/R signals.
   */
  sr_strength?: string | null;
}

/**
 * A trade intent produced after a personality passes all 5 filter stages.
 *
 * Consumed by management handlers (T-28 Holder, T-29 Adjuster, T-30 Reducer)
 * which dispatch the actual trade open based on `personality.managementStyle`.
 */
export interface TradeIntent {
  personalityId: string;
  signal: IncomingSignal;
  personality: PersonalityConfig;
}

// ---------------------------------------------------------------------------
// Internal: DB row shape for personality_configs SELECT *
// ---------------------------------------------------------------------------

interface DbPersonalityRow {
  id: string;
  name: string;
  display_name: string;
  group_type: 'reference' | 'learning';
  entry_type: 'fixed_time' | 'momentum_exhaustion' | 'any_signal' | 'sr_anchored';
  management_style: 'hold' | 'roll' | 'cut_reenter';
  is_frozen: boolean;
  is_active: boolean;
  phase: number;
  params: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Internal: DB row shape returned by the open-trades reconciliation query
// ---------------------------------------------------------------------------

interface OpenTradeRow {
  id: string;
  personality_id: string | null;
  personality_name: string | null;
  management_style: string | null;
  status: string;
}

// ---------------------------------------------------------------------------
// PersonalityRouter
// ---------------------------------------------------------------------------

export class PersonalityRouter {
  private readonly _db: Pool;
  private readonly _redis: Redis;
  private readonly _clock: Clock;

  /**
   * Singleton PaperTradeExecutor instance. Moved to constructor level to avoid
   * instantiating a new executor (and QuantiplyStub) on every signal that opens a
   * trade — one instance is reused for the lifetime of the router.
   */
  private readonly _executor: PaperTradeExecutor;

  /** Shutdown flag — checked in the read loop to exit cleanly. */
  private _stopped = false;

  /**
   * Epoch-ms of the most-recent signal that carried a non-null VIX value.
   * Used for the VIX staleness gate. Initialised to clock.now() at construction
   * so the gate does not immediately fire on the very first signal before we
   * have seen any VIX data — this is intentional: we assume VIX is fresh at
   * startup and only start tracking staleness once signals flow.
   */
  private _lastVixTimestampMs: number;

  /**
   * How many milliseconds a VIX reading can be absent before we block trade
   * opens. Read from VIX_STALE_MS env var; defaults to 300,000 ms (5 minutes).
   */
  private readonly _vixStaleMs: number;

  /**
   * Maximum phase number of personalities to activate.
   * Read from ACTIVE_PHASE env var; defaults to 1.
   *
   * Phase 1 (default): only Phase-1 personalities are loaded. Levelhead
   *   (phase=2) is excluded even if is_active=TRUE.
   * Phase 2 (ACTIVE_PHASE=2): includes Levelhead and all other Phase-2
   *   personalities. Set this when the S/R detection engine is deployed.
   *
   * This replaces the previous hardcoded `phase <= 1` filter in
   * _loadActivePersonalities so Phase 2 can be toggled via env without a
   * code change.
   */
  private readonly _activePhase: number;

  // ---------------------------------------------------------------------------
  // Personality config cache
  //
  // The personality_configs table is a tiny, rarely-changing 10-row table.
  // Querying it on every signal (~1,500/day) is safe but unnecessary. A 60-second
  // TTL cache means config changes (via the CRUD API) are reflected within one
  // minute — fast enough for operations, and negligible staleness risk since
  // personality parameters are only changed deliberately by the operator.
  //
  // The cache is keyed by expiry timestamp (not by invalidation events) so no
  // additional coordination is needed when the CRUD API mutates rows.
  // ---------------------------------------------------------------------------

  private _personalityCache: PersonalityConfig[] | null = null;
  private _personalityCacheExpiresMs = 0;
  private readonly _personalityCacheTtlMs = 60_000; // 60 seconds

  constructor(db: Pool, redis: Redis, clock: Clock) {
    this._db = db;
    this._redis = redis;
    this._clock = clock;
    this._lastVixTimestampMs = clock.now();

    // Instantiate once at construction so trade opens reuse a single executor
    // and QuantiplyStub rather than creating a new instance per signal.
    this._executor = new PaperTradeExecutor({ db: this._db, quantiply: new QuantiplyStub() });

    // Parse VIX_STALE_MS env var. Fall back to 300,000 ms (5 minutes) if
    // absent or not a valid positive integer. A zero/negative value would
    // disable all trading immediately, so we clamp to the default.
    const rawVixStaleMs = Number.parseInt(process.env.VIX_STALE_MS ?? '300000', 10);
    this._vixStaleMs =
      Number.isFinite(rawVixStaleMs) && rawVixStaleMs > 0 ? rawVixStaleMs : 300_000;

    // Parse ACTIVE_PHASE env var. Defaults to 1 (Phase 1 personalities only).
    // A non-positive or non-finite value falls back to 1 to avoid accidentally
    // activating Phase 2 personalities in a misconfigured environment.
    const rawActivePhase = Number.parseInt(process.env.ACTIVE_PHASE ?? '1', 10);
    this._activePhase =
      Number.isFinite(rawActivePhase) && rawActivePhase > 0 ? rawActivePhase : 1;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Startup reconciliation, then begin the signal read loop.
   *
   * Reconciliation: load all open paper trades from the DB and log them.
   * This is the anchor point for T-28/T-29/T-30 management handlers —
   * when those land they will re-attach each trade to the correct handler
   * based on personality.management_style.
   */
  async start(): Promise<void> {
    this._stopped = false;

    // --- Step 1: Ensure consumer group exists ---
    // XGROUP CREATE with MKSTREAM creates both the group and the stream key if
    // neither exist. '$' means start from the latest message so we do not
    // replay historical signals on every restart.
    // BUSYGROUP error means the group already exists — swallow it.
    try {
      await this._redis.xgroup('CREATE', STREAM_SIGNALS, 'personality-router', '$', 'MKSTREAM');
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message.startsWith('BUSYGROUP'))) {
        throw err;
      }
      // Group already exists — expected on every restart after the first.
    }

    // --- Step 2: Startup reconciliation ---
    await this._reconcileOpenTrades();

    // --- Step 3: Start the signal read loop ---
    this._readLoop().catch((err: unknown) => {
      console.error('[personality-router] Fatal error in read loop:', err);
    });
  }

  /**
   * Graceful shutdown: set the stop flag so the read loop exits at its next
   * iteration boundary. The loop checks _stopped after each XREADGROUP call.
   */
  async stop(): Promise<void> {
    this._stopped = true;
    // No explicit wait here: the BLOCK timeout (2000 ms) is short enough that
    // the loop will exit within one timeout window. Callers that need to wait
    // should add a short delay or listen for a completion event (Phase 2 concern).
  }

  // ---------------------------------------------------------------------------
  // Startup reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Load all open paper trades from the DB and log them per personality.
   *
   * The LEFT JOIN on personality_configs lets us also surface pre-M2 trades
   * (personality_id IS NULL) without a separate query. Those rows are logged
   * with a note indicating they predate the personality engine.
   *
   * This is the mounting point for T-28/T-29/T-30: once management handlers
   * exist, replace the console.info calls here with handler.adopt(trade).
   */
  private async _reconcileOpenTrades(): Promise<void> {
    const result = await this._db.query<OpenTradeRow>(
      `SELECT
         pt.id,
         pt.personality_id,
         pc.name             AS personality_name,
         pc.management_style AS management_style,
         pt.status
       FROM paper_trades pt
       LEFT JOIN personality_configs pc ON pc.id = pt.personality_id
       WHERE pt.status = 'open'`,
    );

    if (result.rows.length === 0) {
      console.info('[personality-router] Startup reconciliation: no open trades found');
      return;
    }

    console.info(
      `[personality-router] Startup reconciliation: found ${result.rows.length} open trade(s)`,
    );

    for (const row of result.rows) {
      if (row.personality_id === null) {
        // Pre-M2 trade: opened before the personality engine was deployed.
        // No management handler to re-attach — log and skip.
        console.info(
          `[personality-router] Open trade ${row.id} has no personality_id (pre-M2 trade) — skipping re-adoption`,
        );
      } else {
        // T-28/T-29/T-30: dispatch to management handler based on management_style.
        // For now (handlers not yet implemented), log the intent and continue.
        console.info(
          `[personality-router] Open trade ${row.id} — personality: ${row.personality_name ?? row.personality_id} ` +
            `(management_style=${row.management_style ?? 'unknown'}) — awaiting T-28/T-29/T-30 handler`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Personality config cache loader
  // ---------------------------------------------------------------------------

  /**
   * Returns the active personality configs, using a 60-second in-memory cache.
   *
   * Cache hit: returns the cached list immediately (no DB round-trip).
   * Cache miss: queries personality_configs, maps rows to PersonalityConfig,
   *   stores the result, and sets the expiry timestamp.
   *
   * The mapping from DB snake_case to camelCase is inlined here (not a
   * standalone helper) because it is only needed by this single call site.
   */
  private async _loadActivePersonalities(): Promise<PersonalityConfig[]> {
    const nowMs = this._clock.now();
    if (this._personalityCache !== null && nowMs < this._personalityCacheExpiresMs) {
      return this._personalityCache;
    }

    // phase <= $1 replaces the previous hardcoded `phase <= 1` so Phase 2
    // personalities (e.g. Levelhead) can be activated by setting ACTIVE_PHASE=2
    // without a code change. The parameterised form ($1) prevents SQL injection
    // even though _activePhase is parsed from env (defence in depth).
    const result = await this._db.query<DbPersonalityRow>(
      'SELECT * FROM personality_configs WHERE is_active = TRUE AND phase <= $1 ORDER BY created_at',
      [this._activePhase],
    );

    this._personalityCache = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      groupType: row.group_type,
      entryType: row.entry_type,
      managementStyle: row.management_style,
      isFrozen: row.is_frozen,
      isActive: row.is_active,
      phase: row.phase,
      params: row.params,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    this._personalityCacheExpiresMs = nowMs + this._personalityCacheTtlMs;

    return this._personalityCache;
  }

  // ---------------------------------------------------------------------------
  // Read loop
  // ---------------------------------------------------------------------------

  /**
   * Long-running XREADGROUP loop. Reads batches of up to 10 signals at a time
   * and processes each one in sequence (to avoid interleaving the portfolio
   * serialisation step across concurrent signal handlers).
   *
   * BLOCK 2000 means: wait up to 2 seconds for new messages before returning
   * an empty result. This keeps shutdown latency below 2 seconds while avoiding
   * CPU-busy polling.
   */
  private async _readLoop(): Promise<void> {
    while (!this._stopped) {
      let raw: unknown;
      try {
        raw = await this._redis.xreadgroup(
          'GROUP',
          'personality-router',
          'primary',
          'COUNT',
          10,
          'BLOCK',
          2000,
          'STREAMS',
          STREAM_SIGNALS,
          '>',
        );
      } catch (err: unknown) {
        if (this._stopped) break;
        console.error('[personality-router] XREADGROUP error:', err);
        // Brief back-off to avoid a tight CPU loop on persistent errors.
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        continue;
      }

      if (!raw || !Array.isArray(raw) || raw.length === 0) {
        // No messages — BLOCK timeout expired. Loop and try again.
        continue;
      }

      // Parse the nested ioredis response: [[streamName, [[id, [k,v,...]], ...]]]
      const streamEntry = (raw as [string, Array<[string, string[]]>][])[0];
      if (!streamEntry) continue;
      const messages = streamEntry[1];
      if (!messages || messages.length === 0) continue;

      for (const [msgId, flatFields] of messages) {
        if (this._stopped) break;
        try {
          await this._handleSignal(msgId, flatFields);
          // ACK only after successful handling. If handleSignal throws, the
          // message stays pending and can be reclaimed after 60 s by XAUTOCLAIM.
          await this._redis.xack(STREAM_SIGNALS, 'personality-router', msgId);
        } catch (err: unknown) {
          console.error(`[personality-router] Error handling signal message ${msgId}:`, err);
          // Do NOT ACK — let it stay pending for recovery.
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Signal handler
  // ---------------------------------------------------------------------------

  /**
   * Process one signal message: parse fields, load personalities, batch-fetch
   * DailyState, run filters in parallel, then open trades for passing personalities.
   *
   * @param _msgId     The Redis stream message ID (used by the caller for ACK)
   * @param flatFields The raw flat [k, v, k, v, ...] field array from ioredis
   */
  private async _handleSignal(_msgId: string, flatFields: string[]): Promise<void> {
    // --- Step 1: Deserialise stream fields into a Record<string, string> ---
    const fields: Record<string, string> = {};
    for (let i = 0; i < flatFields.length - 1; i += 2) {
      const key = flatFields[i] as string;
      const val = flatFields[i + 1] as string;
      fields[key] = val;
    }

    // --- Step 2: Parse into IncomingSignal ---
    const signal = this._parseSignal(fields);
    if (signal === null) {
      // Malformed signal — log and skip. The message will be ACKed by the
      // caller so it does not block future signals. This is preferable to
      // leaving a permanently unprocessable pending message.
      console.warn('[personality-router] Received malformed signal — skipping:', fields);
      return;
    }

    // --- Step 3: VIX staleness update ---
    // If this signal carries a valid VIX value, record the timestamp so the
    // staleness gate knows VIX data is still flowing.
    if (signal.vix !== null && signal.vix !== 'null') {
      this._lastVixTimestampMs = this._clock.now();
    } else {
      // VIX is unavailable for this signal — log a warning and continue.
      // Missing VIX must not block signal routing (filter Stage 3 pass-on-null).
      console.warn('[personality-router] VIX unavailable for signal routing', {
        signalId: signal.signalId,
      });
    }

    // --- Step 4: VIX staleness gate ---
    // Block all new trade opens if VIX data has not been seen recently.
    const vixStaleDurationMs = this._clock.now() - this._lastVixTimestampMs;
    if (vixStaleDurationMs > this._vixStaleMs) {
      const staleSecs = Math.floor(vixStaleDurationMs / 1000);
      console.warn(
        `[personality-router] VIX stale for ${staleSecs}s — blocking all new trade opens`,
      );
      return;
    }

    // --- Step 5: Load active personalities (phase <= ACTIVE_PHASE) ---
    // ACTIVE_PHASE defaults to 1; set to 2 to include Phase-2 personalities
    // (e.g. Levelhead). Uses the 60-second in-memory cache to avoid a DB
    // round-trip on every signal.
    const personalities = await this._loadActivePersonalities();

    if (personalities.length === 0) {
      console.info('[personality-router] No active personalities found — nothing to route');
      return;
    }

    // --- Step 6: Batch DailyState fetch — one Promise.all, not N sequential calls ---
    // todayIST is the IST date string used by fetchDailyState's date filter.
    const todayIST = this._clock.today();

    // Pass signal.underlying so the open-leg count is scoped per index (T-44
    // D2 Option A). Each personality sees only its own open legs for the
    // current signal's underlying — NIFTY legs don't count against a BANKNIFTY
    // leg cap and vice versa.
    const dailyStates = await Promise.all(
      personalities.map((p) => fetchDailyState(this._db, p.id, todayIST, signal.underlying)),
    );

    // --- Step 7: Parallel filter fan-out ---
    // runPersonalityFilter is pure/synchronous (no I/O), so wrapping in Promise.all
    // is safe. We convert IncomingSignal → StraddleSignalInput here (once, not N
    // times inside the map) so the conversion cost is paid only once per signal.
    // We use clock.now() rather than Date.now() so tests can inject a fixed time.
    const nowMs = this._clock.now();
    const straddleSignal = toStraddleSignalInput(signal);

    // M5a fix: parse BLOCKED_DATES once per signal (env is static after startup).
    // Previously, runPersonalityFilter called parseBlockedDates() internally,
    // which runs JSON.parse(process.env.BLOCKED_DATES) on every invocation —
    // 10 JSON.parse() calls per signal with 10 personalities. Parsing once here
    // and passing the ReadonlySet eliminates 9 redundant parses per signal.
    const blockedDatesSet = parseBlockedDatesSet();

    const filterResults = await Promise.all(
      personalities.map((p, i) => {
        // personalities and dailyStates arrays are co-indexed: both are produced
        // from the same personalities array via map(), so index i always aligns.
        const dailyState = dailyStates[i];
        if (dailyState === undefined) {
          throw new Error('[personality-router] dailyStates not co-indexed with personalities');
        }
        return runPersonalityFilter(straddleSignal, p, dailyState, nowMs, blockedDatesSet);
      }),
    );

    // --- Step 8: Collect passing personalities as trade intents ---
    const passingIntents: TradeIntent[] = [];
    for (let i = 0; i < personalities.length; i++) {
      const result = filterResults[i];
      const personality = personalities[i];
      if (result === undefined || personality === undefined) continue;
      if (result.pass) {
        passingIntents.push({ personalityId: personality.id, signal, personality });
      } else {
        console.info(
          `[personality-router] Signal ${signal.signalId} rejected for ${personality.name}` +
            ` at stage ${result.stage}: ${result.reason}`,
        );
      }
    }

    if (passingIntents.length === 0) {
      console.info(
        `[personality-router] Signal ${signal.signalId} rejected by all ${personalities.length} personalities`,
      );
      return;
    }

    // --- Step 9: Portfolio warning (hard enforcement deferred to T-31) ---
    // The task contract says: log a warning if more than 4 personalities would
    // open simultaneously. The hard limit lives in portfolio-risk.ts (T-31).
    if (passingIntents.length > 4) {
      console.warn(
        `[personality-router] ${passingIntents.length} personalities passed filters simultaneously (max 4 recommended) — T-31 portfolio-risk check not yet implemented`,
      );
    }

    // --- Step 10: Serialised trade opens (AFTER parallel filter results are known) ---
    // We open trades one at a time to avoid race conditions where concurrent INSERTs
    // both see 0 open positions and bypass portfolio limits. This serialisation is
    // intentional — it matches the acceptance criterion: "portfolio risk check is
    // serialized (runs AFTER Promise.all filter results are known)".
    for (const intent of passingIntents) {
      await this._openTradeForPersonality(intent);
    }
  }

  // ---------------------------------------------------------------------------
  // Trade opening
  // ---------------------------------------------------------------------------

  /**
   * Opens a paper trade for one passing personality.
   *
   * Converts the IncomingSignal to an EntryIntent (as required by
   * PaperTradeExecutor.openTrade), then immediately UPDATEs the paper_trades
   * row to populate personality_id, signal_id, and underlying (migration 004
   * and migration 015 columns respectively).
   *
   * Why the two-step INSERT + UPDATE instead of a single INSERT?
   *   PaperTradeExecutor.openTrade() does not accept personalityId/signalId/
   *   underlying — adding those parameters would require modifying that module
   *   (which is out of scope for T-27). The UPDATE is equivalent and keeps
   *   concerns separated.
   *
   * Why underlying in the same UPDATE?
   *   Migration 015 (FIX-A) added an `underlying TEXT` column so that the
   *   per-index daily-stop and open-leg-cap queries can filter on
   *   `underlying = $N`. Without populating this column the per-index risk
   *   controls match nothing (NULL = fail-open). We set it here in the same
   *   UPDATE round-trip to avoid a second DB query.
   *
   * Errors from openTrade are caught and logged: one failed trade open must not
   * prevent other personalities from opening their trades in the same signal batch.
   */
  private async _openTradeForPersonality(intent: TradeIntent): Promise<void> {
    const { personalityId, signal, personality } = intent;

    // Portfolio-level hard risk check (event-day, VIX stale, daily stop, margin, max legs).
    // vixAgeMs is derived from _lastVixTimestampMs which tracks when we last saw a live VIX tick.
    const vixAgeMs = this._clock.now() - this._lastVixTimestampMs;
    const riskResult = await portfolioRiskCheck(
      this._db,
      {
        personalityId: personalityId,
        underlying: signal.underlying,
        atmStrike: signal.atm_strike,
        straddleValue: Number(signal.straddle_value),
      },
      this._clock,
      vixAgeMs,
    );

    if (!riskResult.allowed) {
      console.warn(
        `[personality-router] portfolioRiskCheck blocked trade for ${personality.name}: ${riskResult.reason}`,
      );
      return;
    }

    // Build an EntryIntent from the signal — the shape required by openTrade().
    // T-44: remove the `as 'NIFTY'` cast that was a Phase 1 placeholder. The
    // real underlying from the signal is propagated directly so that Phase 2
    // BankNifty and Sensex signals are handled correctly. PaperTradeExecutor
    // accepts `string` for underlying, so no downstream cast is needed.
    const entryIntent = {
      straddleValue: signal.straddle_value,
      atmStrike: signal.atm_strike,
      underlying: signal.underlying,
      spot: signal.spot,
      // vix is a string | null on IncomingSignal; openTrade expects string | null.
      vixAtEntry: signal.vix !== 'null' ? signal.vix : null,
      entryTimeMs: signal.signal_time,
    };

    // Reuse the singleton executor instantiated in the constructor.
    const executor = this._executor;

    let tradeId: string;
    try {
      // EntryIntent.underlying is typed as literal 'NIFTY' in entry-engine.ts
      // (Phase 1 constraint, out of scope for T-44 to change). We cast the
      // whole object here so the real underlying value flows through at runtime
      // while the legacy EntryIntent type constraint is satisfied. When Phase 2
      // widens EntryIntent.underlying to string, this cast can be removed.
      tradeId = await executor.openTrade(entryIntent as EntryIntent);
    } catch (err: unknown) {
      console.error(
        `[personality-router] openTrade failed for personality ${personality.name}:`,
        err,
      );
      return;
    }

    // Associate the trade with the personality, signal, and underlying index
    // (migration 004 columns: personality_id, signal_id; migration 015 column:
    // underlying). All three are set in one UPDATE round-trip — no second query.
    //
    // underlying is set here because PaperTradeExecutor.openTrade() does not
    // accept it (out of scope), and without it the per-index daily-stop /
    // open-leg-cap queries (FIX-A) match nothing (NULL = fail-open).
    //
    // signal.underlying is the bare index name (e.g. 'NIFTY', 'BANKNIFTY',
    // 'SENSEX') — exactly what the per-index risk queries compare against.
    try {
      await this._db.query(
        `UPDATE paper_trades
           SET personality_id = $1,
               signal_id      = $2,
               underlying     = $3
         WHERE id = $4`,
        [personalityId, signal.signalId, signal.underlying, tradeId],
      );
    } catch (err: unknown) {
      // Personality/signal/underlying association update failed. The trade row
      // exists but is unlinked and unindexed. Log for investigation; do not
      // throw (the trade is already open).
      console.error(
        `[personality-router] Failed to set personality_id/signal_id/underlying on trade ${tradeId}:`,
        err,
      );
      return;
    }

    console.info(
      `[personality-router] Opened trade ${tradeId} for personality ${personality.name} ` +
        `(managementStyle=${personality.managementStyle}) — signal ${signal.signalId}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Signal parsing
  // ---------------------------------------------------------------------------

  /**
   * Parses a flat Redis stream field map into an IncomingSignal.
   *
   * Returns null if required fields are missing or invalid — the caller must
   * skip and ACK the message so it does not permanently block the pipeline.
   *
   * We are lenient about signal_type: an unknown value is treated as invalid
   * because the filter engine has a closed union type for signalType.
   *
   * NOTE: The `signal` field in the stream is parsed as IncomingSignal here, but
   * when passed to runPersonalityFilter it is converted to StraddleSignalInput
   * (which uses camelCase and numeric types). The cast at the call site is safe
   * because we perform the numeric conversions inline below.
   */
  private _parseSignal(fields: Record<string, string>): IncomingSignal | null {
    const signalId = fields.signal_id ?? '';
    if (!signalId) {
      console.warn('[personality-router] Signal missing signal_id — skipping');
      return null;
    }

    const rawSignalType = fields.signal_type ?? '';
    const validSignalTypes = ['MOMENTUM_EXHAUSTION', 'SCHEDULED', 'PULLBACK'] as const;
    type ValidSignalType = (typeof validSignalTypes)[number];
    if (!(validSignalTypes as readonly string[]).includes(rawSignalType)) {
      console.warn(`[personality-router] Unknown signal_type '${rawSignalType}' — skipping`);
      return null;
    }
    const signal_type = rawSignalType as ValidSignalType;

    const underlying = fields.underlying ?? '';
    if (!underlying) {
      console.warn('[personality-router] Signal missing underlying — skipping');
      return null;
    }

    const atm_strike = Number.parseFloat(fields.atm_strike ?? '');
    if (!Number.isFinite(atm_strike)) {
      console.warn('[personality-router] Signal missing/invalid atm_strike — skipping');
      return null;
    }

    const spot = fields.spot ?? '';
    if (!spot) {
      console.warn('[personality-router] Signal missing spot — skipping');
      return null;
    }

    const straddle_value = fields.straddle_value ?? '';
    if (!straddle_value) {
      console.warn('[personality-router] Signal missing straddle_value — skipping');
      return null;
    }

    // vix is optional — 'null' string or absent both map to null.
    const rawVix = fields.vix ?? null;
    const vix = rawVix === null || rawVix === 'null' || rawVix === '' ? null : rawVix;

    const adjusted_probability = Number.parseFloat(fields.adjusted_probability ?? '');
    if (!Number.isFinite(adjusted_probability)) {
      console.warn('[personality-router] Signal missing/invalid adjusted_probability — skipping');
      return null;
    }

    const confidence_tier = fields.confidence_tier ?? '';
    if (!confidence_tier) {
      console.warn('[personality-router] Signal missing confidence_tier — skipping');
      return null;
    }

    const rawSignalTime = fields.signal_time ?? '';
    // PeakDetectionEngine publishes an ISO-8601 string; ScheduledSignalEmitter may
    // publish epoch ms as a string. Handle both.
    // Number("2026-05-19T09:30:00.000Z") → NaN; Number("1716123000000") → valid epoch.
    const signal_time_ms = Number.isNaN(Number(rawSignalTime))
      ? new Date(rawSignalTime).getTime()
      : Number(rawSignalTime);
    if (!Number.isFinite(signal_time_ms)) {
      console.warn('[personality-router] Signal missing/invalid signal_time — skipping');
      return null;
    }

    // sr_subtype: optional S/R discriminator field. Only 'SR_REVERSAL' is
    // accepted; any other value (or absent) maps to null. We are strict here
    // so that a malformed or unexpected sr_subtype value never accidentally
    // passes the sr_anchored Stage 1 gate.
    const rawSrSubtype = fields.sr_subtype;
    const sr_subtype: 'SR_REVERSAL' | null =
      rawSrSubtype === 'SR_REVERSAL' ? 'SR_REVERSAL' : null;

    // sr_strength: optional [0.0, 1.0] score, transmitted as a string on the
    // stream. Absent or non-numeric values map to null (treated as 0 by Stage
    // 4 when doing the sr_strength_threshold comparison).
    const rawSrStrength = fields.sr_strength;
    const sr_strength: string | null =
      rawSrStrength !== undefined && rawSrStrength !== '' && rawSrStrength !== 'null'
        ? rawSrStrength
        : null;

    return {
      signalId: signalId,
      signal_type,
      underlying,
      atm_strike,
      spot,
      straddle_value,
      vix,
      adjusted_probability,
      confidence_tier,
      signal_time: signal_time_ms,
      sr_subtype,
      sr_strength,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal: build StraddleSignalInput from IncomingSignal
// ---------------------------------------------------------------------------

/**
 * Converts an IncomingSignal (wire format from Redis stream) to a
 * StraddleSignalInput (the type expected by runPersonalityFilter).
 *
 * The conversion is separate from _parseSignal so the type transformation
 * is explicit and the filter can remain independent of the stream format.
 *
 * Exported for use in unit tests that want to test the conversion.
 */
export function toStraddleSignalInput(signal: IncomingSignal): StraddleSignalInput {
  return {
    signalType: signal.signal_type,
    signalId: signal.signalId,
    underlying: signal.underlying,
    atmStrike: signal.atm_strike,
    // spot is a string from the stream; StraddleSignalInput.spot is number.
    spot: Number.parseFloat(signal.spot),
    // straddle_value is a string from the stream; StraddleSignalInput.straddleValue is number.
    straddleValue: Number.parseFloat(signal.straddle_value),
    // vix: null when the stream field is absent/null; parseFloat otherwise.
    vix: signal.vix !== null ? Number.parseFloat(signal.vix) : null,
    adjustedProbability: signal.adjusted_probability,
    // confidenceTier: validate the value maps to the expected union.
    confidenceTier: (['HIGH', 'MEDIUM', 'LOW'].includes(signal.confidence_tier)
      ? signal.confidence_tier
      : 'LOW') as 'HIGH' | 'MEDIUM' | 'LOW',
    signalTimeMs: signal.signal_time,
    // Pass through sr_subtype directly — it is already validated/normalised to
    // 'SR_REVERSAL' | null by _parseSignal (no re-validation needed here).
    sr_subtype: signal.sr_subtype ?? null,
    // sr_strength: the stream carries it as a string; parse to number for the
    // filter. null when absent so Stage 4 treats it as 0 (conservative default).
    sr_strength:
      signal.sr_strength !== null && signal.sr_strength !== undefined
        ? Number.parseFloat(signal.sr_strength)
        : null,
  };
}
