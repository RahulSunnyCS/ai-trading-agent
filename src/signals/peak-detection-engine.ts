/**
 * PeakDetectionEngine — real-time momentum exhaustion detector for ATM straddle values.
 *
 * Subscribes to the `straddle.values` Redis stream and identifies momentum exhaustion
 * peaks: moments where the straddle has expanded significantly from its morning open,
 * the rate of change (ROC) is decelerating, and the deceleration has persisted for
 * multiple candles. These events signal that the initial premium expansion is peaking
 * and decay may begin soon — the ideal entry for a premium-selling strategy.
 *
 * Algorithm overview (four conditions must be met simultaneously):
 *   1. expansionPct >= minExpansionPct (default 10%) — straddle has expanded enough
 *      from its 9:15 AM open value to be worth fading.
 *   2. acceleration < accelerationThreshold (default -0.5) — ROC is decelerating
 *      sharply, not just slowing gradually.
 *   3. ROC has declined for >= rocDeclineCandles (default 3) consecutive snapshots —
 *      the deceleration is sustained, not a single outlier.
 *   4. >= confirmationCandles (default 2) bars where all three above conditions held
 *      simultaneously — prevents triggering on a single noisy bar.
 *
 * Signal deduplication: once a signal fires for an underlying, no second signal
 * fires for that underlying within dedupWindowSecs (default 300 seconds).
 *
 * OI change: read from Redis key `straddle_oi_change:{underlying}` (set by
 * StraddleCalculator). Null if unavailable — scorer applies 0 OI adjustment.
 *
 * Macro context: fetched from Redis via getMacroContext(). Null macro fields
 * produce 0 macro adjustments — the scorer handles nulls gracefully.
 *
 * Design decisions:
 *   - In-memory snapshot history is bounded per underlying (maxHistory snapshots)
 *     to prevent unbounded RAM growth during a full trading session.
 *   - EMA initialisation uses the first straddleValue as the seed so there is no
 *     warm-up gap — the EMA is valid from the second snapshot onward.
 *   - rawExhaustionScore is not clamped: the DB column stores the raw weighted sum
 *     which can exceed 1.0. The scoreProbability function maps this to a bounded
 *     probability via its own internal formula.
 *   - DB writes use parameterised queries. Never interpolate values into SQL strings.
 *   - Redis stream publish (signals.generated) uses XADD with auto-generated ID ('*').
 */

import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { getMacroContext, type MacroContext } from "../ingestion/global-macro-feed.js";
import { STREAM_SIGNALS, STREAM_STRADDLE } from "../redis/client.js";
import type { Clock } from "../utils/clock.js";
import { scoreProbability } from "./probability-scorer.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for the peak detection algorithm.
 * All thresholds are read from environment variables at engine startup;
 * this interface is the typed representation after parsing.
 */
export interface PeakDetectionConfig {
  /** Minimum straddle expansion from 9:15 AM open to consider a signal (percent). */
  minExpansionPct: number;
  /** Acceleration threshold below which deceleration is considered significant. */
  accelerationThreshold: number;
  /** Number of consecutive snapshots that ROC must have declined to confirm deceleration. */
  rocDeclineCandles: number;
  /** Number of bars where all three expansion/acceleration/ROC conditions must hold before firing. */
  confirmationCandles: number;
  /** Minimum time between signals for the same underlying (seconds). */
  dedupWindowSecs: number;
}

// ---------------------------------------------------------------------------
// Internal types (not exported — implementation detail)
// ---------------------------------------------------------------------------

/** One entry in the per-underlying snapshot history. */
interface SnapshotEntry {
  time: number;
  straddleValue: number;
  /** Rate-of-change: (sv[t] - sv[t-1]) / sv[t-1]. Null for the first snapshot. */
  roc: number | null;
  /** Second derivative of sv: roc[t] - roc[t-1]. Null for first two snapshots. */
  acceleration: number | null;
}

/** Accumulated per-underlying computation state. */
interface UnderlyingState {
  /** Full snapshot history, bounded to maxHistory entries (oldest removed first). */
  snapshots: SnapshotEntry[];
  /** EMA-8 over straddleValue history. Null until the first snapshot. */
  ema8: number | null;
  /** EMA-20 over straddleValue history. Null until the first snapshot. */
  ema20: number | null;
  /** The first straddleValue after 9:15 AM IST (open reference). Null until seen. */
  openStraddleValue: number | null;
  /** Epoch-ms at which openStraddleValue was locked. */
  openLockedMs: number | null;
  /** How many consecutive snapshots the ROC has declined. Resets on any non-decline. */
  rocDeclineStreak: number;
  /** How many consecutive bars all three pre-conditions (expansion, acceleration, ROC streak) held. */
  confirmationStreak: number;
  /** Epoch-ms at which the last signal was published. Used for deduplication. */
  lastSignalMs: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Consumer group and consumer name for the straddle.values stream. */
const CONSUMER_GROUP = "peak-detection";
const CONSUMER_NAME = "primary";

/**
 * Maximum snapshot history retained per underlying.
 * A full trading session (6.25 hours) at 15-second intervals = 1500 snapshots.
 * We keep 200: enough for all rolling computations while bounding memory.
 */
const MAX_HISTORY = 200;

/** EMA smoothing factors: alpha = 2 / (N + 1) */
const EMA8_ALPHA = 2 / (8 + 1);   // ≈ 0.2222
const EMA20_ALPHA = 2 / (20 + 1); // ≈ 0.0952

/** IST offset in milliseconds (+5:30). IST has no DST so this is a fixed constant. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads and parses the PeakDetectionConfig from environment variables.
 * Called once at engine startup so misconfigured values surface immediately.
 */
export function readConfigFromEnv(): PeakDetectionConfig {
  const parseNum = (envKey: string, defaultVal: number): number => {
    const raw = process.env[envKey];
    if (raw === undefined || raw === "") return defaultVal;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : defaultVal;
  };

  return {
    minExpansionPct: parseNum("SIGNAL_MIN_EXPANSION_PCT", 10),
    accelerationThreshold: parseNum("SIGNAL_ACCELERATION_THRESHOLD", -0.5),
    rocDeclineCandles: parseNum("SIGNAL_ROC_DECLINE_CANDLES", 3),
    confirmationCandles: parseNum("SIGNAL_CONFIRMATION_CANDLES", 2),
    dedupWindowSecs: parseNum("SIGNAL_DEDUP_WINDOW_SECS", 300),
  };
}

/**
 * Applies an EMA step.
 * If prevEma is null (no prior value), seeds with the current value so the EMA
 * is valid immediately — no warm-up gap required.
 */
function stepEma(prevEma: number | null, current: number, alpha: number): number {
  if (prevEma === null) {
    return current; // Seed: first snapshot becomes the initial EMA value.
  }
  return prevEma * (1 - alpha) + current * alpha;
}

/**
 * Returns true if the IST time for the given epoch-ms falls after 9:15 AM.
 * Used to determine whether a snapshot qualifies as the "open" reference point.
 *
 * We use UTC arithmetic with the fixed +5:30 offset (no DST in IST) rather
 * than toLocaleString to keep this hot-path computation fast.
 */
function isAfterMarketOpen(epochMs: number): boolean {
  const istDate = new Date(epochMs + IST_OFFSET_MS);
  const istHour = istDate.getUTCHours();
  const istMin = istDate.getUTCMinutes();
  // After 9:15 AM means: hour > 9, or (hour == 9 and minute >= 15)
  return istHour > 9 || (istHour === 9 && istMin >= 15);
}

// ---------------------------------------------------------------------------
// PeakDetectionEngine
// ---------------------------------------------------------------------------

/**
 * Subscribes to straddle.values and publishes MOMENTUM_EXHAUSTION signals.
 *
 * One instance should be created per process. The start() method begins the
 * consumer loop; stop() sets a flag so the loop exits at its next iteration.
 */
export class PeakDetectionEngine {
  private readonly _db: Pool;
  private readonly _redis: Redis;
  private readonly _config: PeakDetectionConfig;
  private readonly _clock: Clock;

  /** Per-underlying computation state. Keyed by underlying name (e.g. 'NIFTY'). */
  private readonly _state: Map<string, UnderlyingState> = new Map();

  /** Set to false by stop() to exit the consumer loop. */
  private _running = false;

  constructor(db: Pool, redis: Redis, config: PeakDetectionConfig, clock: Clock) {
    this._db = db;
    this._redis = redis;
    this._config = config;
    this._clock = clock;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Starts the consumer loop. Creates the consumer group if needed (MKSTREAM).
   * Idempotent: calling start() on an already-running engine is a no-op.
   */
  async start(): Promise<void> {
    if (this._running) {
      return;
    }
    this._running = true;

    // Create the consumer group before the first XREADGROUP call.
    // MKSTREAM ensures the stream key exists even if no messages have been
    // published yet. BUSYGROUP error (group already exists) is swallowed.
    await this._ensureConsumerGroup();

    // Run the read loop in the background. Errors inside the loop are caught
    // and logged; a single bad message must not terminate the loop.
    void this._consumeLoop();

    console.log("[PeakDetectionEngine] Started — consuming straddle.values");
  }

  /**
   * Signals the consumer loop to exit at its next iteration.
   * Any in-flight message processing completes normally.
   */
  async stop(): Promise<void> {
    this._running = false;
    console.log("[PeakDetectionEngine] Stopped");
  }

  // --------------------------------------------------------------------------
  // Consumer group management
  // --------------------------------------------------------------------------

  private async _ensureConsumerGroup(): Promise<void> {
    try {
      // '$' start ID: consume only new messages from this point forward.
      // MKSTREAM creates the stream key if it does not exist yet.
      await this._redis.xgroup(
        "CREATE",
        STREAM_STRADDLE,
        CONSUMER_GROUP,
        "$",
        "MKSTREAM",
      );
    } catch (err: unknown) {
      // BUSYGROUP means the group already exists — expected on every restart
      // after the first run. Rethrow all other errors.
      if (err instanceof Error && err.message.startsWith("BUSYGROUP")) {
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
          "GROUP",
          CONSUMER_GROUP,
          CONSUMER_NAME,
          "COUNT",
          10,
          "BLOCK",
          2000, // 2 second block — short enough for responsive stop()
          "STREAMS",
          STREAM_STRADDLE,
          ">", // '>' = messages not yet delivered to this group
        );
      } catch (err: unknown) {
        if (!this._running) break;
        // Log the error and back off briefly before retrying to avoid tight
        // error loops on transient Redis issues.
        console.error("[PeakDetectionEngine] Redis read error:", err);
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        continue;
      }

      const messages = this._parseXreadgroupResponse(raw);

      for (const { id, fields } of messages) {
        if (!this._running) break;
        try {
          await this._handleSnapshot(fields);
          // ACK only after successful processing. If _handleSnapshot throws,
          // the message stays pending and will be reclaimed by XAUTOCLAIM later.
          await this._redis.xack(STREAM_STRADDLE, CONSUMER_GROUP, id);
        } catch (err: unknown) {
          console.error(`[PeakDetectionEngine] Handler error for message ${id}:`, err);
          // Do NOT ACK — message remains pending for recovery.
        }
      }
    }
  }

  /**
   * Parses the raw ioredis XREADGROUP response into usable message objects.
   *
   * Raw shape from ioredis:
   *   [ [streamName, [ [id, [k, v, k, v, ...]], ...]] ]
   *
   * We read from exactly one stream so we always take index 0.
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
  // Snapshot handler
  // --------------------------------------------------------------------------

  /**
   * Processes one straddle snapshot message.
   *
   * Steps:
   *   1. Parse fields from the Redis message.
   *   2. Update per-underlying computation state (EMA, ROC, acceleration).
   *   3. Check if all four exhaustion conditions are met.
   *   4. If yes and not deduplicated: fetch macro/OI context, score, write DB, publish.
   */
  async _handleSnapshot(fields: Record<string, string>): Promise<void> {
    // Parse required fields. Missing or unparseable fields abort the snapshot.
    const time = Number(fields["time"]);
    const underlying = fields["underlying"];
    const spot = Number(fields["spot"]);
    const atmStrike = Number(fields["atmStrike"]);
    const straddleValue = Number(fields["straddleValue"]);
    const vixRaw = fields["vix"];
    const vix = vixRaw === "null" || vixRaw === undefined ? null : Number(vixRaw);

    // Guard against malformed messages. All numeric fields must be finite.
    if (
      !Number.isFinite(time) ||
      !underlying ||
      !Number.isFinite(spot) ||
      !Number.isFinite(atmStrike) ||
      !Number.isFinite(straddleValue)
    ) {
      console.warn("[PeakDetectionEngine] Malformed snapshot — skipping:", fields);
      return;
    }

    // Skip placeholder snapshots (straddleValue === 0) emitted in SIMULATE mode
    // before the simulator produces real option prices. Recording a 0 as the open
    // reference would produce nonsensical expansion percentages.
    if (straddleValue === 0) {
      return;
    }

    // Retrieve or create state for this underlying.
    const state = this._getOrCreateState(underlying);

    // Update EMAs first (both are needed even when no signal fires, as they
    // are part of the state that future snapshots may read — though currently
    // they are stored for external consumers, not used in the exhaustion check).
    state.ema8 = stepEma(state.ema8, straddleValue, EMA8_ALPHA);
    state.ema20 = stepEma(state.ema20, straddleValue, EMA20_ALPHA);

    // Lock the open straddle value at the first snapshot after 9:15 AM IST.
    // We skip straddleValue === 0 above so openStraddleValue is always positive.
    if (state.openStraddleValue === null && isAfterMarketOpen(time)) {
      state.openStraddleValue = straddleValue;
      state.openLockedMs = time;
    }

    // Compute ROC and acceleration from the last two snapshots.
    const prevEntry = state.snapshots[state.snapshots.length - 1] ?? null;
    let roc: number | null = null;
    let acceleration: number | null = null;

    if (prevEntry !== null && prevEntry.straddleValue > 0) {
      roc = (straddleValue - prevEntry.straddleValue) / prevEntry.straddleValue;
    }

    // Acceleration requires two prior ROC values (the prior entry's ROC and the
    // one before that). We use the previous entry's roc as roc[t-1].
    if (roc !== null && prevEntry?.roc !== null && prevEntry?.roc !== undefined) {
      acceleration = roc - prevEntry.roc;
    }

    // Append the new snapshot to history. Trim oldest if over the limit.
    const entry: SnapshotEntry = { time, straddleValue, roc, acceleration };
    state.snapshots.push(entry);
    if (state.snapshots.length > MAX_HISTORY) {
      state.snapshots.shift(); // O(n) but MAX_HISTORY is small enough (200)
    }

    // Update the consecutive ROC decline streak.
    if (roc !== null && prevEntry?.roc !== null && prevEntry?.roc !== undefined) {
      if (roc < prevEntry.roc) {
        state.rocDeclineStreak++;
      } else {
        // Any non-decline resets the streak — we need consecutive declines.
        state.rocDeclineStreak = 0;
      }
    } else {
      // Not enough history yet — no streak.
      state.rocDeclineStreak = 0;
    }

    // Compute expansion percentage from the open reference.
    let expansionPct: number | null = null;
    if (state.openStraddleValue !== null && state.openStraddleValue > 0) {
      expansionPct = ((straddleValue - state.openStraddleValue) / state.openStraddleValue) * 100;
    }

    // Check the three pre-conditions for this bar.
    const expansionMet =
      expansionPct !== null && expansionPct >= this._config.minExpansionPct;
    const accelerationMet =
      acceleration !== null && acceleration < this._config.accelerationThreshold;
    const rocDeclineMet =
      state.rocDeclineStreak >= this._config.rocDeclineCandles;

    if (expansionMet && accelerationMet && rocDeclineMet) {
      state.confirmationStreak++;
    } else {
      // Any condition failing resets the confirmation counter. We require the
      // conditions to hold for consecutive bars, not just accumulate over time.
      state.confirmationStreak = 0;
    }

    // All four conditions must hold.
    const allConditionsMet =
      expansionMet &&
      accelerationMet &&
      rocDeclineMet &&
      state.confirmationStreak >= this._config.confirmationCandles;

    if (!allConditionsMet) {
      return;
    }

    // Deduplication: skip if a signal was published for this underlying recently.
    const now = this._clock.now();
    if (state.lastSignalMs !== null) {
      const elapsed = now - state.lastSignalMs;
      if (elapsed < this._config.dedupWindowSecs * 1000) {
        return;
      }
    }

    // All conditions met and dedup cleared — publish a signal.
    state.lastSignalMs = now;

    // Compute the raw exhaustion score (unclamped).
    // Three weighted contributions:
    //   - Relative expansion (how far the straddle has moved from open)
    //   - Acceleration magnitude (how sharply the momentum is decelerating)
    //   - ROC decline streak (how long the deceleration has been sustained)
    //
    // Weights are chosen so each factor contributes comparably to the score
    // when at moderate values. The score is unclamped because scoreProbability
    // maps it to a bounded probability with its own internal formula.
    const rawExpansionComponent = (expansionPct as number) / 50;
    const rawAccelerationComponent = Math.abs(Math.min(acceleration as number, 0)) * 2;
    const rawRocComponent = state.rocDeclineStreak / 10;
    const rawExhaustionScore = rawExpansionComponent + rawAccelerationComponent + rawRocComponent;

    // Fetch macro context. If getMacroContext throws (e.g. Redis outage),
    // fall back to all-null so the scorer applies 0 macro adjustment rather
    // than crashing the signal pipeline.
    let macro: MacroContext;
    try {
      macro = await getMacroContext(this._redis);
    } catch {
      macro = {
        us_vix: null,
        sp500: null,
        dax: null,
        crude_oil: null,
        gold: null,
      };
    }

    // Read OI change. Null is the safe default — the scorer applies 0 OI
    // adjustment when oiChangePct is null. Any read or parse error is silent.
    let oiChangePct: number | null = null;
    try {
      const oiRaw = await this._redis.get(`straddle_oi_change:${underlying}`);
      if (oiRaw !== null) {
        const parsed = Number(oiRaw);
        if (Number.isFinite(parsed)) {
          oiChangePct = parsed;
        }
      }
    } catch {
      // Silent fail — OI is supplemental data.
    }

    // Score the signal probability.
    const scoreResult = scoreProbability({
      rawExhaustionScore,
      signalType: "MOMENTUM_EXHAUSTION",
      indiaVix: vix,
      macro,
      oiChangePct,
      signalTimeMs: now,
      clock: this._clock,
    });

    const { adjustedProbability, confidenceTier, adjustmentBreakdown } = scoreResult;

    // Write to straddle_signals table.
    // All parameterised — no string interpolation.
    const dbResult = await this._db.query<{ id: string }>(
      `INSERT INTO straddle_signals
         (time, underlying, signal_type, atm_strike, spot, straddle_value,
          vix, raw_exhaustion_score, adjusted_probability, confidence_tier,
          expansion_pct, roc_decline_candles, acceleration_value, adjustment_breakdown)
       VALUES
         ($1, $2, 'MOMENTUM_EXHAUSTION', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        new Date(now),                             // $1: time (TIMESTAMPTZ)
        underlying,                                // $2: underlying
        String(atmStrike),                         // $3: atm_strike (NUMERIC)
        String(spot),                              // $4: spot (NUMERIC)
        String(straddleValue),                     // $5: straddle_value (NUMERIC)
        vix !== null ? String(vix) : null,         // $6: vix (NUMERIC, nullable)
        String(rawExhaustionScore),                // $7: raw_exhaustion_score (NUMERIC)
        String(adjustedProbability),               // $8: adjusted_probability (NUMERIC)
        confidenceTier,                            // $9: confidence_tier (TEXT)
        String(expansionPct as number),            // $10: expansion_pct (NUMERIC)
        state.rocDeclineStreak,                    // $11: roc_decline_candles (INTEGER)
        String(acceleration as number),            // $12: acceleration_value (NUMERIC)
        JSON.stringify(adjustmentBreakdown),       // $13: adjustment_breakdown (TEXT JSON)
      ],
    );

    const signalId = dbResult.rows[0]?.id ?? "unknown";

    // Publish to signals.generated Redis stream.
    // All values are serialised as strings because Redis Streams only store strings.
    const signalFields: Record<string, string> = {
      signal_type: "MOMENTUM_EXHAUSTION",
      signal_id: signalId,
      underlying,
      atm_strike: String(atmStrike),
      spot: String(spot),
      straddle_value: String(straddleValue),
      vix: vix !== null ? String(vix) : "null",
      adjusted_probability: String(adjustedProbability),
      confidence_tier: confidenceTier,
      signal_time: new Date(now).toISOString(),
    };

    const flatFields: string[] = [];
    for (const [k, v] of Object.entries(signalFields)) {
      flatFields.push(k, v);
    }

    await this._redis.xadd(STREAM_SIGNALS, "*", ...flatFields);

    console.log(
      `[PeakDetectionEngine] Signal published: ${underlying} ${confidenceTier} ` +
        `prob=${adjustedProbability.toFixed(3)} expansion=${(expansionPct as number).toFixed(1)}%`,
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
      snapshots: [],
      ema8: null,
      ema20: null,
      openStraddleValue: null,
      openLockedMs: null,
      rocDeclineStreak: 0,
      confirmationStreak: 0,
      lastSignalMs: null,
    };
    this._state.set(underlying, newState);
    return newState;
  }
}
