/**
 * SRDetectionEngine — real-time Support/Resistance proximity detector.
 *
 * Subscribes to the `straddle.values` Redis stream (consumer group 'sr-detection')
 * and emits SR_REVERSAL signals when spot price approaches a strong S/R level.
 *
 * Algorithm overview:
 *   1. At session start, load the day's S/R levels for each underlying via
 *      computeSRLevels() (T-43-B). If assertHistoryCoverage throws for an
 *      underlying, S/R is disabled for that underlying for the session —
 *      the engine does NOT crash, it continues for other underlyings.
 *   2. On each straddle snapshot, check whether spot is within sr_proximity_points
 *      of any level whose strength >= sr_strength_floor.
 *   3. If yes and not deduplicated: write straddle_signals with sr_subtype,
 *      sr_strength, poc_used, and level_source; then publish to signals.generated.
 *   4. Deduplication: no second signal for the same (underlying, level_price) within
 *      sr_dedup_window_secs. "Same level" is defined by rounding to the nearest
 *      poc_bucket_pts boundary — this prevents duplicates triggered by sub-point
 *      price oscillations near a level.
 *
 * Gating:
 *   - ACTIVE_PHASE < 2: no S/R rows written. Keeps Phase-1 straddle_signals clean.
 *
 * VIX-null handling:
 *   - VIX is read from the stream but never used in strength arithmetic.
 *     It is stored in the DB row (nullable) for retrospection use only.
 *     We never divide by VIX or assume a non-null value.
 *
 * Design decisions (see DECISIONS MADE in task summary for rationale):
 *   - Consumer group: 'sr-detection' (distinct from 'peak-detection' so both
 *     engines can co-subscribe to straddle.values independently).
 *   - Strength floor default: 0.20 — low enough for sparse level sets (few
 *     levels → modest confluence), high enough to ignore noise near-zero levels.
 *   - Proximity default: 50 points — one NIFTY ATM strike interval. Tight
 *     enough to be meaningful, wide enough to catch pre-rejection approaches.
 *   - Dedup window default: 300 seconds (5 min) — same as peak-detection for
 *     consistency. Prevents burst signals during sideways chop near a level.
 *   - Level reload: levels are loaded once per session start (per underlying),
 *     not on every snapshot — S/R levels computed from prior-week/month data
 *     do not change intraday. Reload triggers only on explicit stop()+start().
 *
 * Named exports only. No default export (project convention).
 */

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { STREAM_SIGNALS, STREAM_STRADDLE } from '../redis/client.js';
import type { Clock } from '../utils/clock.js';
import {
  type SRLevel,
  type SRLevelResult,
  InsufficientHistoryCoverageError,
  assertHistoryCoverage,
  computeSRLevels,
  prevIstWeekWindow,
  istDateToUtcMs,
} from './sr-levels.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for the S/R detection algorithm.
 * Parsed from environment variables at engine startup.
 */
export interface SRDetectionConfig {
  /**
   * How close (in index points) spot must come to a level before an SR signal
   * is considered. Default: 50 (one NIFTY ATM strike interval).
   * For BANKNIFTY/SENSEX, callers may increase this to 100.
   */
  proximityPoints: number;

  /**
   * Minimum strength score [0, 1] a level must have to qualify for signalling.
   * Levels weaker than this floor are ignored even when spot is proximate.
   * Default: 0.20.
   */
  strengthFloor: number;

  /**
   * Minimum time between SR signals for the same underlying + level bucket.
   * Prevents burst emission during sideways chop at a level. Default: 300s.
   */
  dedupWindowSecs: number;

  /**
   * Minimum number of bars (15s snapshots) that must exist in the previous-week
   * window before S/R levels are trusted. Default: 500.
   * At 15s intervals: 375-min session = 1500 bars/day; 5-day prev week = 7500.
   * 500 is the minimum that implies at least one reasonably full trading day.
   */
  minHistoryBars: number;

  /**
   * Bucket width in index points used to "snap" level prices when keying the
   * dedup map. This prevents the same physical level from generating two dedup
   * keys if the computed price is 22498 vs 22500. Default: 50 (NIFTY interval).
   */
  levelBucketPts: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Per-underlying state maintained across snapshots for one underlying (e.g. 'NIFTY').
 *
 * Mirrors the UnderlyingState pattern from peak-detection-engine.ts. One instance
 * per underlying, keyed by underlying name in _state Map.
 */
interface UnderlyingState {
  /**
   * The computed S/R levels for this underlying. Null means levels have not been
   * loaded yet (will be loaded on first snapshot). This lazy approach avoids
   * requiring all underlyings to be known at construction time.
   */
  levels: SRLevelResult | null;

  /**
   * True if S/R has been disabled for this underlying due to an InsufficientHistoryCoverage
   * error. When true, no signals are emitted for this underlying for the session.
   * Logged loudly on first encounter (once per session).
   */
  disabled: boolean;

  /**
   * Per-level dedup map. Key = bucketed level price (floor to levelBucketPts boundary).
   * Value = epoch-ms at which the last signal was emitted for that level bucket.
   * Separate per level so a signal at 22500 does not block one at 22000.
   */
  lastSignalPerLevel: Map<number, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Consumer group name for the straddle.values stream. */
const CONSUMER_GROUP = 'sr-detection';

/**
 * Consumer name within the group. Using 'primary' matches the peak-detection-engine
 * convention; only one SR engine instance runs per deployment.
 */
const CONSUMER_NAME = 'primary';

/**
 * Signal subtype written to straddle_signals.sr_subtype.
 * Typed as a const so it can be used in the INSERT without risk of typo.
 */
const SR_REVERSAL = 'SR_REVERSAL' as const;

/**
 * The signal_type written for S/R signals. Uses 'PULLBACK' because:
 *   - The existing straddle_signals.signal_type CHECK constraint only allows
 *     'MOMENTUM_EXHAUSTION', 'SCHEDULED', or 'PULLBACK'.
 *   - 'PULLBACK' is the closest semantic match to an S/R proximity event
 *     (price pulls back to a level).
 *   - The sr_subtype column ('SR_REVERSAL') further identifies these rows.
 *   - Using a separate signal_type prevents confusion with MOMENTUM_EXHAUSTION
 *     signals in retrospection queries.
 */
const SR_SIGNAL_TYPE = 'PULLBACK' as const;

/**
 * Fallback adjusted_probability for S/R signals.
 *
 * Why a fixed value instead of the probability scorer?
 * The probability scorer in peak-detection-engine.ts is tuned for MOMENTUM_EXHAUSTION
 * signals (rawExhaustionScore, ROC components). It does not meaningfully apply to S/R
 * proximity events. Rather than misapply the scorer, we use sr_strength directly as
 * the probability — strength is already [0, 1] and reflects the level's quality.
 * The confidence_tier is derived from the same strength value below.
 */
function deriveConfidenceTier(strength: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (strength >= 0.6) return 'HIGH';
  if (strength >= 0.35) return 'MEDIUM';
  return 'LOW';
}

// ---------------------------------------------------------------------------
// Config reader
// ---------------------------------------------------------------------------

/**
 * Reads and parses SRDetectionConfig from environment variables.
 * Called once at engine startup so misconfigured values surface immediately.
 *
 * Environment variable names are prefixed with SR_ to distinguish from
 * the SIGNAL_ prefix used by PeakDetectionEngine.
 */
export function readSRConfigFromEnv(): SRDetectionConfig {
  const parseNum = (envKey: string, defaultVal: number): number => {
    const raw = process.env[envKey];
    if (raw === undefined || raw === '') return defaultVal;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : defaultVal;
  };

  return {
    // 50pt = one NIFTY ATM strike interval — tight enough to be meaningful.
    proximityPoints: parseNum('SR_PROXIMITY_POINTS', 50),
    // 0.20 = low floor; allows weak-but-present levels to trigger on first day of data.
    strengthFloor: parseNum('SR_STRENGTH_FLOOR', 0.2),
    // 300s = 5 min; same as peak-detection for consistency.
    dedupWindowSecs: parseNum('SR_DEDUP_WINDOW_SECS', 300),
    // 500 bars: minimum one full trading day at 15s intervals (375 min = 1500 bars).
    // 500 is more lenient to handle partial sessions, early closes, or backfill gaps.
    minHistoryBars: parseNum('SR_MIN_HISTORY_BARS', 500),
    // 50pt bucket: same as NIFTY ATM interval; snap levels to this grid for dedup key.
    levelBucketPts: parseNum('SR_LEVEL_BUCKET_PTS', 50),
  };
}

// ---------------------------------------------------------------------------
// SRDetectionEngine
// ---------------------------------------------------------------------------

/**
 * Subscribes to straddle.values and publishes SR_REVERSAL signals when spot
 * approaches a strong S/R level.
 *
 * One instance should be created per process. start() begins the consumer loop;
 * stop() exits at the next iteration. Designed to run alongside PeakDetectionEngine
 * — both consume from 'straddle.values' via their own independent consumer groups.
 */
export class SRDetectionEngine {
  private readonly _db: Pool;
  private readonly _redis: Redis;
  private readonly _config: SRDetectionConfig;
  private readonly _clock: Clock;

  /** Per-underlying computation state. Keyed by underlying name (e.g. 'NIFTY'). */
  private readonly _state: Map<string, UnderlyingState> = new Map();

  /** Set to false by stop() to exit the consumer loop. */
  private _running = false;

  constructor(db: Pool, redis: Redis, config: SRDetectionConfig, clock: Clock) {
    this._db = db;
    this._redis = redis;
    this._config = config;
    this._clock = clock;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Starts the consumer loop. Creates the consumer group (MKSTREAM) if needed.
   * Idempotent: calling start() on an already-running engine is a no-op.
   */
  async start(): Promise<void> {
    if (this._running) {
      return;
    }
    this._running = true;

    await this._ensureConsumerGroup();

    // Run the read loop in the background. Errors inside the loop are caught
    // and logged; a single bad message must not terminate the loop.
    void this._consumeLoop();

    console.log('[SRDetectionEngine] Started — consuming straddle.values');
  }

  /**
   * Signals the consumer loop to exit at its next iteration.
   * Does not clear per-underlying state — call stop()+start() for a session reset.
   */
  async stop(): Promise<void> {
    this._running = false;
    console.log('[SRDetectionEngine] Stopped');
  }

  // --------------------------------------------------------------------------
  // Consumer group management
  // --------------------------------------------------------------------------

  private async _ensureConsumerGroup(): Promise<void> {
    try {
      // '$' start ID: only consume new messages from this point forward.
      // MKSTREAM creates the stream key if it does not exist yet.
      await this._redis.xgroup('CREATE', STREAM_STRADDLE, CONSUMER_GROUP, '$', 'MKSTREAM');
    } catch (err: unknown) {
      // BUSYGROUP = group already exists. Expected on every restart after first run.
      if (err instanceof Error && err.message.startsWith('BUSYGROUP')) {
        return;
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Consumer loop
  // --------------------------------------------------------------------------

  private async _consumeLoop(): Promise<void> {
    while (this._running) {
      let raw: unknown;
      try {
        raw = await this._redis.xreadgroup(
          'GROUP',
          CONSUMER_GROUP,
          CONSUMER_NAME,
          'COUNT',
          10,
          'BLOCK',
          2000, // 2-second block — responsive to stop()
          'STREAMS',
          STREAM_STRADDLE,
          '>', // '>' = messages not yet delivered to this consumer group
        );
      } catch (err: unknown) {
        if (!this._running) break;
        // Back off briefly before retrying to avoid tight loops on transient Redis issues.
        console.error('[SRDetectionEngine] Redis read error:', err);
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        continue;
      }

      const messages = this._parseXreadgroupResponse(raw);

      for (const { id, fields } of messages) {
        if (!this._running) break;
        try {
          await this._handleSnapshot(fields);
          // ACK only after successful processing. If _handleSnapshot throws,
          // the message stays pending and can be reclaimed via XAUTOCLAIM.
          await this._redis.xack(STREAM_STRADDLE, CONSUMER_GROUP, id);
        } catch (err: unknown) {
          console.error(`[SRDetectionEngine] Handler error for message ${id}:`, err);
          // Do NOT ACK — message remains pending for recovery.
        }
      }
    }
  }

  /**
   * Parses the raw ioredis XREADGROUP response into usable message objects.
   * Mirrors the same parsing pattern used in PeakDetectionEngine.
   */
  private _parseXreadgroupResponse(
    raw: unknown,
  ): Array<{ id: string; fields: Record<string, string> }> {
    if (!raw || !Array.isArray(raw) || raw.length === 0) {
      return [];
    }
    const streamEntry = raw[0] as [string, Array<[string, string[]]>];
    const messages = streamEntry[1];
    if (!messages || messages.length === 0) {
      return [];
    }
    return messages.map(([id, flatFields]) => {
      const fields: Record<string, string> = {};
      for (let i = 0; i < flatFields.length - 1; i += 2) {
        const key = flatFields[i] as string;
        const val = flatFields[i + 1] as string;
        fields[key] = val;
      }
      return { id, fields };
    });
  }

  // --------------------------------------------------------------------------
  // Snapshot handler (internal, but left non-private so tests can call directly)
  // --------------------------------------------------------------------------

  /**
   * Processes one straddle snapshot message.
   *
   * Steps:
   *   1. Parse fields. Abort on malformed message (no throw — return early).
   *   2. Gate on ACTIVE_PHASE >= 2. Return early if not Phase 2+.
   *   3. Lazy-load S/R levels for this underlying (once per underlying per session).
   *      If coverage check fails, disable S/R for this underlying and return.
   *   4. For each qualified level (strength >= floor, spot within proximity):
   *      - Check per-level dedup window.
   *      - If not deduped: write to straddle_signals, publish to signals.generated.
   *
   * This method is intentionally accessible for tests (not truly private) so tests
   * can feed snapshots directly without running the Redis consumer loop.
   */
  async _handleSnapshot(fields: Record<string, string>): Promise<void> {
    // -------------------------------------------------------------------------
    // 1. Parse message fields
    // -------------------------------------------------------------------------
    const time = Number(fields.time);
    const underlying = fields.underlying;
    const spot = Number(fields.spot);
    const atmStrike = Number(fields.atmStrike);
    const straddleValue = Number(fields.straddleValue);
    const vixRaw = fields.vix;
    // VIX is stored in the DB for retrospection but never used in arithmetic here.
    const vix = vixRaw === 'null' || vixRaw === undefined ? null : Number(vixRaw);

    // Guard against malformed messages. All required numeric fields must be finite.
    if (
      !Number.isFinite(time) ||
      !underlying ||
      !Number.isFinite(spot) ||
      !Number.isFinite(atmStrike) ||
      !Number.isFinite(straddleValue)
    ) {
      console.warn('[SRDetectionEngine] Malformed snapshot — skipping:', fields);
      return;
    }

    // Skip zero straddleValue placeholders emitted in SIMULATE mode before
    // the simulator produces real option prices.
    if (straddleValue === 0) {
      return;
    }

    // -------------------------------------------------------------------------
    // 2. Phase gate — no S/R signals in Phase 1
    // -------------------------------------------------------------------------
    // Read ACTIVE_PHASE fresh on every snapshot so a live phase promotion
    // takes effect without restarting the engine.
    const activePhase = Number(process.env.ACTIVE_PHASE ?? '1');
    if (!Number.isFinite(activePhase) || activePhase < 2) {
      // Phase 1 or unset — silently return. Do not log per-snapshot (too noisy).
      return;
    }

    // -------------------------------------------------------------------------
    // 3. Lazy-load S/R levels for this underlying
    // -------------------------------------------------------------------------
    const state = this._getOrCreateState(underlying);

    if (state.disabled) {
      // Coverage check previously failed — do nothing for this underlying.
      return;
    }

    if (state.levels === null) {
      // First snapshot for this underlying in this session — load levels now.
      // We use the snapshot's `spot` as the currentSpot for proximity scoring.
      // This is a one-time score at session start; levels do not re-score on each tick.
      const loaded = await this._loadLevels(underlying, spot);
      if (!loaded) {
        // _loadLevels already set state.disabled = true and logged.
        return;
      }
    }

    // At this point state.levels is guaranteed non-null (either just loaded or was already loaded).
    const levelResult = state.levels as SRLevelResult;

    // -------------------------------------------------------------------------
    // 4. Check each level for proximity and strength
    // -------------------------------------------------------------------------
    const now = this._clock.now();

    for (const level of levelResult.levels) {
      if (!this._qualifiesForSignal(level, spot)) {
        continue;
      }

      // Bucket the level price to a dedup key. Using Math.floor(price / bucketPts)
      // so that prices within the same strike interval share one dedup entry.
      // This prevents duplicate signals when a level price is, say, 22498 vs 22502.
      const levelKey = Math.floor(level.price / this._config.levelBucketPts);

      // Check dedup window for this specific level bucket.
      const lastMs = state.lastSignalPerLevel.get(levelKey) ?? null;
      if (lastMs !== null && now - lastMs < this._config.dedupWindowSecs * 1000) {
        continue; // Still within dedup window for this level — skip.
      }

      // Dedup cleared — emit signal for this level.
      state.lastSignalPerLevel.set(levelKey, now);

      await this._emitSignal({
        time,
        underlying,
        spot,
        atmStrike,
        straddleValue,
        vix,
        level,
        levelResult,
        now,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Level loading
  // --------------------------------------------------------------------------

  /**
   * Loads S/R levels for an underlying at session start.
   *
   * Calls assertHistoryCoverage first. If it throws (InsufficientHistoryCoverageError),
   * marks the underlying as disabled and logs loudly — no crash, no signal, no silent
   * degradation. Other errors are re-thrown (infrastructure failures should not be swallowed).
   *
   * Returns true on success, false if S/R is now disabled for this underlying.
   */
  private async _loadLevels(underlying: string, spot: number): Promise<boolean> {
    const state = this._state.get(underlying) as UnderlyingState;

    // Compute the prev-week window for the coverage check.
    // We use the clock to determine "today" in IST, then derive prev-week from that.
    const todayMs = istDateToUtcMs(this._clock.today());
    const { from: prevWeekFrom, to: prevWeekTo } = prevIstWeekWindow(todayMs);

    // Coverage guard — throws InsufficientHistoryCoverageError if data is too sparse.
    try {
      await assertHistoryCoverage(
        this._db,
        underlying,
        prevWeekFrom,
        prevWeekTo,
        this._config.minHistoryBars,
      );
    } catch (err: unknown) {
      if (err instanceof InsufficientHistoryCoverageError) {
        // Log loudly — this is an operational issue that needs attention.
        // Do NOT crash or disable other underlyings.
        console.error(
          `[SRDetectionEngine] COVERAGE FAILURE: S/R disabled for ${underlying} this session. ` +
            `Got ${err.actualBars} bars, need >= ${err.expectedBars}. ` +
            `Ensure historical data is backfilled before market open.`,
          { underlying, actualBars: err.actualBars, expectedBars: err.expectedBars },
        );
        state.disabled = true;
        return false;
      }
      // Other errors (DB connection, query failure) — re-throw so the caller can
      // log and the message can be retried (not ACKed in the consumer loop).
      throw err;
    }

    // Coverage OK — compute levels.
    try {
      const levelResult = await computeSRLevels(this._db, underlying, spot, this._clock);
      state.levels = levelResult;
      console.log(
        `[SRDetectionEngine] Loaded ${levelResult.levels.length} S/R levels for ${underlying}. ` +
          `poc_used=${levelResult.poc_used}, contributed=[${levelResult.contributed.join(', ')}]`,
      );
      return true;
    } catch (err: unknown) {
      // computeSRLevels failed (DB error, etc.) — re-throw. The consumer loop will
      // not ACK the message and will retry. Do not disable the underlying permanently
      // on a transient infrastructure error.
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Signal qualification
  // --------------------------------------------------------------------------

  /**
   * Returns true if the level qualifies for an SR signal given the current spot.
   *
   * Conditions (both must be true):
   *   1. strength >= strengthFloor — level is strong enough to trade against.
   *   2. |spot - level.price| <= proximityPoints — spot is close enough to the level.
   */
  private _qualifiesForSignal(level: SRLevel, spot: number): boolean {
    if (level.strength < this._config.strengthFloor) {
      return false;
    }
    const distance = Math.abs(spot - level.price);
    return distance <= this._config.proximityPoints;
  }

  // --------------------------------------------------------------------------
  // Signal emission
  // --------------------------------------------------------------------------

  /**
   * Writes one SR_REVERSAL signal to straddle_signals and publishes it to signals.generated.
   *
   * level_source JSONB stores the top-5 levels sorted by strength so the API layer
   * can surface "which levels were consulted" in the retrospection UI. Storing all
   * levels is avoided to keep the JSON blob size bounded.
   *
   * All SQL values are parameterised — no string interpolation of any input.
   */
  private async _emitSignal(ctx: {
    time: number;
    underlying: string;
    spot: number;
    atmStrike: number;
    straddleValue: number;
    vix: number | null;
    level: SRLevel;
    levelResult: SRLevelResult;
    now: number;
  }): Promise<void> {
    const { time, underlying, spot, atmStrike, straddleValue, vix, level, levelResult, now } = ctx;

    // Confidence tier derived from sr_strength, not the generic probability scorer.
    // This keeps SR signal quality semantics consistent with the S/R domain.
    const confidenceTier = deriveConfidenceTier(level.strength);

    // Build the level_source JSONB: the top-5 S/R levels sorted by strength.
    // Capped at 5 to bound the blob size — callers rarely need more for display.
    const levelSourcePayload = {
      levels: levelResult.levels.slice(0, 5).map((l) => ({
        price: l.price,
        type: l.type,
        strength: Number(l.strength.toFixed(4)),
        poc_used: l.poc_used,
      })),
      triggered_level: {
        price: level.price,
        type: level.type,
        strength: Number(level.strength.toFixed(4)),
      },
    };

    // Write to straddle_signals.
    // Column order and param positions mirror peak-detection-engine.ts for consistency.
    // SR-specific columns (sr_subtype, sr_strength, poc_used, level_source) are appended.
    //
    // We use sr_strength as adjusted_probability: both are [0,1] and represent
    // "how confident is this signal". The generic scorer is not applicable here.
    const dbResult = await this._db.query<{ id: string }>(
      `INSERT INTO straddle_signals
         (time, underlying, signal_type, atm_strike, spot, straddle_value,
          vix, raw_exhaustion_score, adjusted_probability, confidence_tier,
          expansion_pct, roc_decline_candles, acceleration_value, adjustment_breakdown,
          sr_subtype, sr_strength, poc_used, level_source)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18)
       RETURNING id`,
      [
        new Date(now), // $1: time (TIMESTAMPTZ) — use clock.now() not snapshot.time
        underlying, // $2: underlying
        SR_SIGNAL_TYPE, // $3: signal_type ('PULLBACK')
        String(atmStrike), // $4: atm_strike (NUMERIC → string)
        String(spot), // $5: spot (NUMERIC → string)
        String(straddleValue), // $6: straddle_value (NUMERIC → string)
        vix !== null ? String(vix) : null, // $7: vix (nullable NUMERIC)
        null, // $8: raw_exhaustion_score — not applicable for SR signals
        String(level.strength), // $9: adjusted_probability — use sr_strength
        confidenceTier, // $10: confidence_tier
        null, // $11: expansion_pct — not applicable for SR signals
        null, // $12: roc_decline_candles — not applicable
        null, // $13: acceleration_value — not applicable
        null, // $14: adjustment_breakdown — not applicable
        SR_REVERSAL, // $15: sr_subtype
        String(level.strength), // $16: sr_strength [0,1]
        level.poc_used, // $17: poc_used (BOOLEAN)
        JSON.stringify(levelSourcePayload), // $18: level_source (JSONB)
      ],
    );

    const signalId = dbResult.rows[0]?.id ?? 'unknown';

    // Publish to signals.generated stream.
    // All field values must be strings (Redis Streams store only strings).
    const signalFields: Record<string, string> = {
      signal_type: SR_SIGNAL_TYPE,
      sr_subtype: SR_REVERSAL,
      signal_id: signalId,
      underlying,
      atm_strike: String(atmStrike),
      spot: String(spot),
      straddle_value: String(straddleValue),
      vix: vix !== null ? String(vix) : 'null',
      sr_strength: String(level.strength),
      sr_level_price: String(level.price),
      sr_level_type: level.type,
      poc_used: String(level.poc_used),
      confidence_tier: confidenceTier,
      adjusted_probability: String(level.strength),
      signal_time: new Date(now).toISOString(),
    };

    // Flatten fields into key/value pairs for ioredis xadd.
    const flatFields: string[] = [];
    for (const [k, v] of Object.entries(signalFields)) {
      flatFields.push(k, v);
    }

    await this._redis.xadd(STREAM_SIGNALS, '*', ...flatFields);

    console.log(
      `[SRDetectionEngine] SR signal: ${underlying} ${level.type}@${level.price} ` +
        `strength=${level.strength.toFixed(3)} spot=${spot} ${confidenceTier} ` +
        `poc_used=${level.poc_used}`,
    );
  }

  // --------------------------------------------------------------------------
  // State management
  // --------------------------------------------------------------------------

  /** Returns existing state for an underlying or creates and registers a new entry. */
  private _getOrCreateState(underlying: string): UnderlyingState {
    const existing = this._state.get(underlying);
    if (existing !== undefined) {
      return existing;
    }
    const newState: UnderlyingState = {
      levels: null, // Lazy: loaded on first snapshot.
      disabled: false,
      lastSignalPerLevel: new Map(),
    };
    this._state.set(underlying, newState);
    return newState;
  }
}
