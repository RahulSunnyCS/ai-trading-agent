/**
 * ScheduledSignalEmitter — emits SCHEDULED and PULLBACK signals.
 *
 * Subscribes to the `straddle.values` Redis stream as consumer group
 * `fallback-signals` / consumer `primary`. On each snapshot it:
 *   1. Emits a SCHEDULED signal at the configured IST time (once per day per underlying).
 *   2. After the daily scheduled signal fires, tracks the running peak straddle value
 *      and emits a PULLBACK signal when the straddle retraces >= pullbackRetracePct%
 *      from that peak.
 *
 * Both signal types are published to the `signals.generated` Redis stream via XADD.
 *
 * Design notes:
 * - IST offsets are computed without date-fns-tz to keep this module dependency-free
 *   beyond ioredis; India has no DST so UTC+5:30 is a fixed constant.
 * - All state (daily fire tracking, peak tracking, dedup timestamps) is in-memory.
 *   A process restart resets the state, which is acceptable for a research tool —
 *   the worst case is a duplicate signal on restart, which the personality filter's
 *   daily-trade-count gate would absorb.
 * - The consumer group uses '$' as the start ID so we only process snapshots that
 *   arrive after the emitter starts; historical backfill is out of scope.
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { STREAM_SIGNALS, STREAM_STRADDLE } from '../redis/client.js';
import type { Clock } from '../utils/clock.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FallbackSignalConfig {
  /** IST time at which the daily SCHEDULED signal fires, e.g. '09:17'. */
  scheduledEntryTime: string;
  /**
   * Percentage the straddle must retrace from its post-scheduled-entry peak
   * before a PULLBACK signal is emitted. Default 3 (= 3%).
   */
  pullbackRetracePct: number;
  /**
   * Number of most-recent snapshots to look back when determining whether the
   * drop from peak happened "recently". Older drops are ignored. Default 8.
   */
  pullbackLookbackCandles: number;
  /**
   * Minimum number of seconds that must pass between consecutive PULLBACK
   * signals for the same underlying. Prevents signal storms. Default 600.
   */
  pullbackDedupWindowSecs: number;
}

// ---------------------------------------------------------------------------
// IST helpers (fixed UTC+5:30 offset, no DST)
// ---------------------------------------------------------------------------

/**
 * Returns a Date object whose UTC components equal the IST wall-clock time.
 * E.g. for epoch 0 (00:00 UTC), the result has UTC hours = 5, minutes = 30.
 * This lets us use getUTCHours() / getUTCMinutes() to read IST time.
 */
function toIST(epochMs: number): Date {
  // IST = UTC + 5 hours 30 minutes = 330 minutes = 19 800 seconds
  return new Date(epochMs + 330 * 60 * 1000);
}

/** Returns 'HH:MM' in IST for the given epoch-ms timestamp. */
function getISTTimeStr(epochMs: number): string {
  const d = toIST(epochMs);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Returns 'YYYY-MM-DD' in IST for the given epoch-ms timestamp. */
function getISTDateStr(epochMs: number): string {
  const d = toIST(epochMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns true if the given epoch-ms falls within IST market hours (09:15–15:30).
 * We use the snapshot time, not the wall clock, so simulated data is handled
 * consistently regardless of when the process runs.
 */
function isDuringMarketHours(epochMs: number): boolean {
  const timeStr = getISTTimeStr(epochMs);
  // Lexicographic comparison is valid for zero-padded HH:MM strings within a day.
  return timeStr >= '09:15' && timeStr <= '15:30';
}

// ---------------------------------------------------------------------------
// Per-underlying in-memory state
// ---------------------------------------------------------------------------

/**
 * Tracks all mutable state for a single underlying symbol.
 * Keyed by underlying name (e.g. 'NIFTY') in ScheduledSignalEmitter._state.
 */
interface UnderlyingState {
  /** IST date string ('YYYY-MM-DD') on which the daily scheduled signal last fired. */
  lastScheduledDate: string | null;
  /**
   * Running peak straddle_value observed since the daily scheduled signal fired.
   * null if the scheduled signal has not yet fired today.
   */
  peakStraddleValue: number | null;
  /**
   * Circular buffer of the last N straddle values used for lookback window checks.
   * Capacity = pullbackLookbackCandles. Oldest entries are overwritten when full.
   */
  recentValues: number[];
  /** Index into recentValues where the next snapshot will be written. */
  recentWriteIdx: number;
  /** Whether the recentValues buffer has been filled at least once. */
  recentFull: boolean;
  /** Epoch-ms at which the last PULLBACK signal was emitted. null = never emitted. */
  lastPullbackMs: number | null;
}

// ---------------------------------------------------------------------------
// ScheduledSignalEmitter
// ---------------------------------------------------------------------------

export class ScheduledSignalEmitter {
  private _stopped = false;

  /** Per-underlying tracking state. Keys are underlying symbol strings, e.g. 'NIFTY'. */
  private readonly _state: Map<string, UnderlyingState> = new Map();

  constructor(
    private readonly redis: Redis,
    private readonly config: FallbackSignalConfig,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the consumer group read loop.
   *
   * Sets up the consumer group (MKSTREAM, BUSYGROUP-safe) then enters the
   * blocking XREADGROUP loop. The loop exits when stop() is called.
   *
   * We implement our own loop here (rather than using the module-level
   * streamConsume helper) so that we can inject the Redis client and run
   * cleanly in unit tests without touching the singleton client or the global
   * shutdownFlag in redis/client.ts.
   */
  async start(): Promise<void> {
    this._stopped = false;

    // Ensure the consumer group exists. MKSTREAM creates the stream if absent.
    // Swallow BUSYGROUP (group already exists from a previous run).
    await this.redis
      .xgroup('CREATE', STREAM_STRADDLE, 'fallback-signals', '$', 'MKSTREAM')
      .catch((e: unknown) => {
        if (!String(e).includes('BUSYGROUP')) throw e;
      });

    // Run the blocking read loop until stop() is called.
    while (!this._stopped) {
      let raw: unknown;
      try {
        // BLOCK 2000ms: server waits up to 2s before returning empty.
        // '>' = deliver messages not yet delivered to this consumer group.
        raw = await this.redis.xreadgroup(
          'GROUP',
          'fallback-signals',
          'primary',
          'COUNT',
          10,
          'BLOCK',
          2000,
          'STREAMS',
          STREAM_STRADDLE,
          '>',
        );
      } catch (err: unknown) {
        if (this._stopped) break;
        console.error('[scheduled-signal-emitter] xreadgroup error:', err);
        // Back off briefly to avoid tight error loops on transient Redis issues.
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        continue;
      }

      if (!raw || !Array.isArray(raw) || raw.length === 0) continue;

      // Parse the ioredis XREADGROUP response shape:
      //   [ [streamName, [ [id, [k, v, k, v, ...]], ... ]] ]
      const streamEntry = raw[0] as [string, Array<[string, string[]]>];
      const messages = streamEntry[1];
      if (!messages || messages.length === 0) continue;

      for (const [id, flatFields] of messages) {
        if (this._stopped) break;

        // Build a Record<string, string> from the flat key/value list.
        const fields: Record<string, string> = {};
        for (let i = 0; i < flatFields.length - 1; i += 2) {
          fields[flatFields[i] as string] = flatFields[i + 1] as string;
        }

        try {
          await this._handleSnapshot(fields);
          // ACK after successful handling so the message leaves the PEL.
          await this.redis.xack(STREAM_STRADDLE, 'fallback-signals', id);
        } catch (err: unknown) {
          // Do NOT ACK — message stays pending for reclaim after 60s.
          console.error(`[scheduled-signal-emitter] handler error for message ${id}:`, err);
        }
      }
    }
  }

  /** Signal the emitter to exit the read loop after the current block timeout. */
  async stop(): Promise<void> {
    this._stopped = true;
  }

  // ---------------------------------------------------------------------------
  // Core snapshot handler
  // ---------------------------------------------------------------------------

  /**
   * Called once per straddle.values message. Implements both signal types.
   *
   * Field names from the straddle calculator (camelCase, matching the stream
   * publish in straddle-calc.ts): time, underlying, spot, atmStrike,
   * straddleValue, vix.
   */
  private async _handleSnapshot(fields: Record<string, string>): Promise<void> {
    // --- Parse and validate the snapshot ---
    const underlying = fields.underlying ?? 'NIFTY';
    const straddleValueStr = fields.straddleValue ?? fields.straddle_value ?? '';
    const straddleValue =
      straddleValueStr !== '' ? Number.parseFloat(straddleValueStr) : Number.NaN;
    const spot = fields.spot ?? '0';
    const atmStrike = fields.atmStrike ?? fields.atm_strike ?? '0';
    const vix = fields.vix ?? '';

    // Use the snapshot's own time for market-hours checking (supports simulation
    // where wall-clock time differs from the simulated trading day).
    // The `time` field is a Unix-ms string published by straddle-calc.ts.
    const snapshotTimeMs =
      fields.time !== undefined ? Number.parseInt(fields.time, 10) : this.clock.now();
    const snapshotTimeMsValid = Number.isFinite(snapshotTimeMs) ? snapshotTimeMs : this.clock.now();

    // Skip zero-value snapshots (simulator placeholder before first tick arrives).
    if (!Number.isFinite(straddleValue) || straddleValue === 0) return;

    // Skip snapshots outside market hours.
    if (!isDuringMarketHours(snapshotTimeMsValid)) return;

    // Ensure per-underlying state is initialised.
    if (!this._state.has(underlying)) {
      this._initState(underlying);
    }
    const state = this._state.get(underlying) as UnderlyingState;

    // Detect midnight / date change and reset daily tracking.
    const snapshotDateStr = getISTDateStr(snapshotTimeMsValid);
    if (state.lastScheduledDate !== null && state.lastScheduledDate !== snapshotDateStr) {
      // A new trading day has started — reset peak tracking and pullback dedup.
      state.peakStraddleValue = null;
      state.lastPullbackMs = null;
      state.recentValues = [];
      state.recentWriteIdx = 0;
      state.recentFull = false;
      // Note: lastScheduledDate is reset below only when we fire today's signal,
      // or will be compared against the new date and found not-equal on the next snapshot.
    }

    // Push this snapshot's value into the lookback buffer.
    this._pushRecentValue(state, straddleValue);

    // --- 1. SCHEDULED signal ---
    const snapshotTimeStr = getISTTimeStr(snapshotTimeMsValid);

    // Fire if: current IST HH:MM matches the configured time AND we haven't
    // fired for this underlying today yet.
    const shouldFireScheduled =
      snapshotTimeStr === this.config.scheduledEntryTime &&
      state.lastScheduledDate !== snapshotDateStr;

    if (shouldFireScheduled) {
      state.lastScheduledDate = snapshotDateStr;
      // Start peak tracking from this snapshot's straddle value.
      state.peakStraddleValue = straddleValue;

      await this._emitSignal({
        signalType: 'SCHEDULED',
        underlying,
        atmStrike,
        spot,
        straddleValue: straddleValueStr,
        vix,
        adjustedProbability: '0.60',
        confidenceTier: 'HIGH',
        signalTimeMs: snapshotTimeMsValid,
      });
    }

    // --- 2. PULLBACK signal ---
    // Only eligible after the daily SCHEDULED signal has fired (peak tracking active).
    if (state.peakStraddleValue !== null) {
      // Update running peak — track the highest straddle seen since scheduled entry.
      if (straddleValue > state.peakStraddleValue) {
        state.peakStraddleValue = straddleValue;
      }

      // Compute the drop from the peak as a percentage.
      const dropPct = ((state.peakStraddleValue - straddleValue) / state.peakStraddleValue) * 100;

      // Check whether the drop occurred within the lookback window.
      // We verify this by checking that the peak value itself was seen within
      // the last pullbackLookbackCandles snapshots OR that the current drop
      // happened within that window. The practical approach: the current value
      // is always the most-recent snapshot, so the "within N candles" condition
      // means the buffer contains at least one value >= peakStraddleValue
      // (i.e. the peak is recent). We check the oldest value in the buffer
      // against the current value — if the oldest value is also <= peak we know
      // the drop started within the window.
      //
      // Simpler equivalent: we consider the drop "within lookback" if the
      // buffer has fewer than pullbackLookbackCandles entries (drop just started)
      // OR if any value in the buffer is >= peakStraddleValue. Since we update
      // the peak greedily above, if the buffer contains the peak value it's
      // within the window.
      const withinLookback = this._isDropWithinLookback(state, state.peakStraddleValue);

      if (
        dropPct >= this.config.pullbackRetracePct &&
        withinLookback &&
        !this._isWithinDedupWindow(state, snapshotTimeMsValid)
      ) {
        state.lastPullbackMs = snapshotTimeMsValid;

        await this._emitSignal({
          signalType: 'PULLBACK',
          underlying,
          atmStrike,
          spot,
          straddleValue: straddleValueStr,
          vix,
          adjustedProbability: '0.60',
          confidenceTier: 'MEDIUM',
          signalTimeMs: snapshotTimeMsValid,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Signal publishing
  // ---------------------------------------------------------------------------

  private async _emitSignal(params: {
    signalType: 'SCHEDULED' | 'PULLBACK';
    underlying: string;
    atmStrike: string;
    spot: string;
    straddleValue: string;
    vix: string;
    adjustedProbability: string;
    confidenceTier: 'HIGH' | 'MEDIUM';
    signalTimeMs: number;
  }): Promise<void> {
    const signalId = randomUUID();
    const signalTime = new Date(params.signalTimeMs).toISOString();

    // The signal shape mirrors StraddleSignal in schema.ts — all fields are
    // string-serialised for the Redis stream (stream values must be strings).
    const fields: Record<string, string> = {
      signal_type: params.signalType,
      signal_id: signalId,
      underlying: params.underlying,
      atm_strike: params.atmStrike,
      spot: params.spot,
      straddle_value: params.straddleValue,
      vix: params.vix,
      adjusted_probability: params.adjustedProbability,
      confidence_tier: params.confidenceTier,
      signal_time: signalTime,
    };

    // Flatten to key/value pairs for ioredis xadd variadic interface.
    const flatFields: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      flatFields.push(k, v);
    }

    await this.redis.xadd(STREAM_SIGNALS, '*', ...flatFields);

    console.info(
      `[scheduled-signal-emitter] emitted ${params.signalType} signal for ${params.underlying} at ${signalTime}`,
    );
  }

  // ---------------------------------------------------------------------------
  // State helpers
  // ---------------------------------------------------------------------------

  private _initState(underlying: string): void {
    this._state.set(underlying, {
      lastScheduledDate: null,
      peakStraddleValue: null,
      recentValues: [],
      recentWriteIdx: 0,
      recentFull: false,
      lastPullbackMs: null,
    });
  }

  /**
   * Push a new straddle value into the fixed-capacity circular lookback buffer.
   * When the buffer is full, the oldest entry is overwritten (ring buffer pattern).
   */
  private _pushRecentValue(state: UnderlyingState, value: number): void {
    const cap = this.config.pullbackLookbackCandles;
    if (state.recentValues.length < cap) {
      state.recentValues.push(value);
    } else {
      // Buffer is already at capacity — overwrite the oldest slot.
      state.recentValues[state.recentWriteIdx] = value;
      state.recentWriteIdx = (state.recentWriteIdx + 1) % cap;
      state.recentFull = true;
    }
  }

  /**
   * Returns true if the given peakValue appears within the recent-values buffer,
   * indicating the peak was reached within the last pullbackLookbackCandles snapshots.
   *
   * We use a tolerance of 0.01 (1 paisa) for floating-point equality.
   * If the buffer has not been filled yet (fewer than lookbackCandles snapshots
   * since scheduled entry), we also consider the drop "within lookback" because
   * all data we have is necessarily recent.
   */
  private _isDropWithinLookback(state: UnderlyingState, peakValue: number): boolean {
    // If the buffer is short (fewer entries than the lookback window), the peak
    // must be within the window by definition — there's no older data.
    if (!state.recentFull && state.recentValues.length < this.config.pullbackLookbackCandles) {
      // As long as we have at least 1 snapshot, the condition holds.
      return state.recentValues.length > 0;
    }
    // Otherwise, check whether any value in the buffer is >= peakValue (within
    // floating-point tolerance). If the buffer contains the peak, it's within window.
    return state.recentValues.some((v) => v >= peakValue - 0.01);
  }

  /**
   * Returns true if the elapsed time since the last PULLBACK signal is less than
   * the configured dedup window, preventing a signal storm.
   */
  private _isWithinDedupWindow(state: UnderlyingState, nowMs: number): boolean {
    if (state.lastPullbackMs === null) return false;
    return nowMs - state.lastPullbackMs < this.config.pullbackDedupWindowSecs * 1000;
  }
}

// ---------------------------------------------------------------------------
// Alias export (both names refer to the same class)
// ---------------------------------------------------------------------------

/**
 * FallbackSignalEmitter is an alias for ScheduledSignalEmitter.
 * Both names are exported to maintain backwards-compatibility with any callers
 * that used the original "fallback" terminology before the rename.
 */
export { ScheduledSignalEmitter as FallbackSignalEmitter };

// ---------------------------------------------------------------------------
// Default config factory (reads from environment variables)
// ---------------------------------------------------------------------------

/**
 * Build a FallbackSignalConfig from environment variables with defaults.
 * Exported so callers can construct the emitter without knowing the env var names.
 */
export function buildConfigFromEnv(): FallbackSignalConfig {
  const scheduledEntryTime = process.env.SCHEDULED_ENTRY_TIME ?? '09:17';

  const rawRetracePct = Number.parseFloat(process.env.PULLBACK_RETRACE_PCT ?? '3');
  const pullbackRetracePct =
    Number.isFinite(rawRetracePct) && rawRetracePct > 0 ? rawRetracePct : 3;

  const rawLookback = Number.parseInt(process.env.PULLBACK_LOOKBACK_CANDLES ?? '8', 10);
  const pullbackLookbackCandles = Number.isFinite(rawLookback) && rawLookback > 0 ? rawLookback : 8;

  const rawDedup = Number.parseInt(process.env.PULLBACK_DEDUP_WINDOW_SECS ?? '600', 10);
  const pullbackDedupWindowSecs = Number.isFinite(rawDedup) && rawDedup > 0 ? rawDedup : 600;

  return {
    scheduledEntryTime,
    pullbackRetracePct,
    pullbackLookbackCandles,
    pullbackDedupWindowSecs,
  };
}
