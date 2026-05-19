/**
 * Injectable Clock abstraction for the AI Trading Agent.
 *
 * All time-dependent code should accept a Clock rather than calling Date.now()
 * or new Date() directly. This makes entry/exit windows, scheduled entries,
 * EOD triggers, and backtesting replay deterministically testable and
 * replayable without patching globals.
 *
 * Three implementations are provided:
 *   - RealClock    — delegates to the system clock; used in production.
 *   - FixedClock   — frozen at a single instant; used in unit tests.
 *   - VirtualClock — starts at a given time, advances at a configurable rate;
 *                    used in replay harnesses and backtesting (T-57).
 */

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

/** The injectable interface — all time-dependent code takes Clock, not Date.now(). */
export interface Clock {
  /** Returns the current moment as a Date object. */
  now(): Date;
  /** Returns milliseconds since epoch (equivalent to Date.now()). */
  timestamp(): number;
}

// ---------------------------------------------------------------------------
// RealClock — production use
// ---------------------------------------------------------------------------

/** Delegates to the system clock. Use this in production code paths. */
export class RealClock implements Clock {
  now(): Date {
    return new Date();
  }

  timestamp(): number {
    return Date.now();
  }
}

// ---------------------------------------------------------------------------
// FixedClock — unit test use
// ---------------------------------------------------------------------------

/**
 * Frozen at a single instant. Calling now() or timestamp() always returns
 * the same value, making test assertions deterministic.
 *
 * Defensive copies are returned from now() so callers cannot mutate the
 * internal state by modifying the returned Date object.
 */
export class FixedClock implements Clock {
  constructor(private readonly fixedTime: Date) {}

  now(): Date {
    // Return a defensive copy so external mutation of the returned Date
    // does not affect subsequent calls.
    return new Date(this.fixedTime.getTime());
  }

  timestamp(): number {
    return this.fixedTime.getTime();
  }
}

// ---------------------------------------------------------------------------
// VirtualClock — backtesting / replay use
// ---------------------------------------------------------------------------

/**
 * Starts at a given virtual time and advances at a configurable multiple of
 * real wall time (rate). Supports:
 *   - rate = 1.0  → real time
 *   - rate = 2.0  → 2× speed (useful for accelerated replay)
 *   - rate = 0    → paused (equivalent to FixedClock but resumable)
 *   - advance(ms) → instantaneous jump, useful in unit tests
 *
 * The clock tracks two anchors:
 *   _startWallMs    — real wall-clock ms at the moment the clock was
 *                     created or last resumed; used to compute elapsed wall time.
 *   _virtualStartMs — virtual ms at _startWallMs; the running virtual
 *                     time is (_virtualStartMs + wallElapsed * _rate).
 *
 * advance() and resume() update these anchors so that past wall-clock
 * elapsed time is not double-counted.
 */
export class VirtualClock implements Clock {
  /** Real wall time (ms) at the moment the clock was created or last resumed. */
  private _startWallMs: number;
  /** Virtual time (ms) at the moment _startWallMs was recorded. */
  private _virtualStartMs: number;
  /** Replay rate: 1.0 = real time, 2.0 = 2× speed, 0 = paused. */
  private _rate: number;

  constructor(startAt: Date, rate = 1.0) {
    this._startWallMs = Date.now();
    this._virtualStartMs = startAt.getTime();
    this._rate = rate;
  }

  now(): Date {
    return new Date(this.timestamp());
  }

  timestamp(): number {
    const wallElapsed = Date.now() - this._startWallMs;
    return this._virtualStartMs + wallElapsed * this._rate;
  }

  /**
   * Instantly advance virtual time by the given number of milliseconds
   * without waiting for real wall time to pass.
   *
   * Implemented by shifting _virtualStartMs forward; _startWallMs is left
   * unchanged so future real-time elapsed continues to accumulate correctly.
   */
  advance(ms: number): void {
    this._virtualStartMs += ms;
  }

  /** Change the replay rate without resetting virtual time. */
  setRate(rate: number): void {
    // Re-anchor so virtual time up to this point is preserved.
    this._virtualStartMs = this.timestamp();
    this._startWallMs = Date.now();
    this._rate = rate;
  }

  /**
   * Pause the virtual clock (rate = 0). Virtual time stops advancing.
   * Call resume() to continue.
   */
  pause(): void {
    // Capture current virtual time before zeroing the rate so timestamp()
    // keeps returning the paused value correctly.
    this._virtualStartMs = this.timestamp();
    this._startWallMs = Date.now();
    this._rate = 0;
  }

  /**
   * Resume the virtual clock after a pause.
   *
   * The wall-clock reference is reset to now so the time spent paused
   * does not count as elapsed virtual time.
   */
  resume(rate = 1.0): void {
    // Virtual start stays as-is (the paused value). Only the wall reference
    // moves forward so wall time accumulated while paused is discarded.
    this._startWallMs = Date.now();
    this._rate = rate;
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Convenience factory — returns the correct Clock implementation based on
 * the supplied options:
 *   - options.fixed   → FixedClock (unit tests)
 *   - options.virtual → VirtualClock (replay / backtesting)
 *   - no options      → RealClock (production)
 */
export function createClock(options?: {
  fixed?: Date;
  virtual?: { startAt: Date; rate?: number };
}): Clock {
  if (options?.fixed !== undefined) return new FixedClock(options.fixed);
  if (options?.virtual !== undefined) {
    return new VirtualClock(options.virtual.startAt, options.virtual.rate);
  }
  return new RealClock();
}

// ---------------------------------------------------------------------------
// IST helpers
// ---------------------------------------------------------------------------

/**
 * IST is UTC+5:30 — a fixed offset with no daylight-saving transitions.
 * Stored in milliseconds for use in timestamp arithmetic.
 */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Return the current time as "HH:MM" in IST (Indian Standard Time).
 *
 * Uses UTC arithmetic on the offset-adjusted timestamp rather than the
 * Intl API, to avoid locale-dependent formatting differences across
 * environments and to keep the function free of external dependencies.
 *
 * Used by entry/exit window logic in the trading engine.
 */
export function toISTTimeString(clock: Clock): string {
  const istMs = clock.timestamp() + IST_OFFSET_MS;
  const d = new Date(istMs);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Return true if the current IST time is within the half-open interval
 * [start, end) where start and end are "HH:MM" strings.
 *
 * The half-open interval matches the convention used in the trading engine:
 * a window of "09:20"–"14:30" includes 09:20 but excludes 14:30, which means
 * a trade placed at exactly 14:30 is outside the window.
 *
 * Used to gate entry and exit windows in the personality decision engine.
 */
export function isWithinWindow(clock: Clock, start: string, end: string): boolean {
  const now = toISTTimeString(clock);
  return now >= start && now < end;
}
