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
 *                    used in replay harnesses and backtesting.
 */

// ---------------------------------------------------------------------------
// IST arithmetic helpers (private to this module)
// ---------------------------------------------------------------------------

/**
 * IST is UTC+5:30 — a fixed offset with no daylight-saving transitions.
 * Stored in milliseconds for use in timestamp arithmetic (module-private use;
 * also exported as IST_OFFSET_MS below for external consumers).
 */
const _IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Convert an epoch-ms value to an IST date string 'YYYY-MM-DD'.
 * Module-private helper used by today(), toISTDate() on all Clock implementations.
 * Avoids duplication and keeps IST conversion logic in one place.
 */
function _istDateString(epochMs: number): string {
  const d = new Date(epochMs + _IST_OFFSET_MS);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Convert an epoch-ms value to an IST time string 'HH:MM:SS'.
 * Module-private helper used by toISTTime() on all Clock implementations.
 */
function _istTimeString(epochMs: number): string {
  const d = new Date(epochMs + _IST_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

/** The injectable interface — all time-dependent code takes Clock, not Date.now(). */
export interface Clock {
  /**
   * Returns milliseconds since epoch (equivalent to Date.now()).
   *
   * NOTE: M2's Clock.now() returns number (epoch ms). Main's Clock.now() returned
   * a Date object. The merged interface uses M2's convention (number) because the
   * vast majority of M2 callers use now() as a number. Code that needs a Date
   * should call `new Date(clock.now())` or use `clock.timestamp()`.
   */
  now(): number;
  /** Returns milliseconds since epoch (equivalent to Date.now()). Alias for now(). */
  timestamp(): number;
  /**
   * Returns the current IST date as a 'YYYY-MM-DD' string.
   * Added for M2 compatibility — M2 code calls clock.today() for date-keyed
   * queries (e.g. "get today's open trades").
   */
  today(): string;
  /**
   * Converts an epoch-ms timestamp to an IST date string 'YYYY-MM-DD'.
   * Added for M2 compatibility — M2 code calls clock.toISTDate(ms) to convert
   * timestamps from external sources (broker ticks, DB rows) to IST dates.
   */
  toISTDate(epochMs: number): string;
  /**
   * Converts an epoch-ms timestamp to an IST time string 'HH:MM:SS'.
   * Added for M2 compatibility — M2 trigger engine and entry engine call
   * clock.toISTTime(ms) to evaluate time-window conditions (entry/exit windows).
   */
  toISTTime(epochMs: number): string;
}

// ---------------------------------------------------------------------------
// RealClock — production use
// ---------------------------------------------------------------------------

/** Delegates to the system clock. Use this in production code paths. */
export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  timestamp(): number {
    return Date.now();
  }

  today(): string {
    return _istDateString(Date.now());
  }

  toISTDate(epochMs: number): string {
    return _istDateString(epochMs);
  }

  toISTTime(epochMs: number): string {
    return _istTimeString(epochMs);
  }
}

// ---------------------------------------------------------------------------
// FixedClock — unit test use
// ---------------------------------------------------------------------------

/**
 * Frozen at a single instant. Calling now() or timestamp() always returns
 * the same value, making test assertions deterministic.
 *
 * Accepts either a Date object or an epoch-ms number so callers can use
 * whichever form is clearest in their test setup.
 *
 * Defensive copies are returned from now() so callers cannot mutate the
 * internal state by modifying the returned Date object.
 */
export class FixedClock implements Clock {
  private readonly _fixed: number;

  /**
   * Accepts a number (epoch ms), a Date object, or an ISO date string.
   * The string form is accepted for M2 test compatibility — M2 tests pass
   * ISO strings like "2026-05-28T03:00:00.000Z" directly to FixedClock.
   */
  constructor(epochMsOrDate: number | Date | string) {
    if (epochMsOrDate instanceof Date) {
      this._fixed = epochMsOrDate.getTime();
    } else if (typeof epochMsOrDate === 'string') {
      // Parse ISO string via the Date constructor (UTC semantics for ISO strings).
      this._fixed = new Date(epochMsOrDate).getTime();
    } else {
      this._fixed = epochMsOrDate;
    }
  }

  now(): number {
    return this._fixed;
  }

  timestamp(): number {
    return this._fixed;
  }

  today(): string {
    return _istDateString(this._fixed);
  }

  toISTDate(epochMs: number): string {
    return _istDateString(epochMs);
  }

  toISTTime(epochMs: number): string {
    return _istTimeString(epochMs);
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
 * Also supports tick callbacks (same pattern as the M2 clock) so that
 * VirtualClock can drive interval-based callbacks in tests deterministically.
 */
export class VirtualClock implements Clock {
  /** Real wall time (ms) at the moment the clock was created or last resumed. */
  private _startWallMs: number;
  /** Virtual time (ms) at the moment _startWallMs was recorded. */
  private _virtualStartMs: number;
  /** Replay rate: 1.0 = real time, 2.0 = 2× speed, 0 = paused. */
  private _rate: number;

  /** Tick callback entries for interval-based callbacks (M2 compatibility). */
  private readonly _ticks: Array<{
    intervalMs: number;
    lastFiredAt: number;
    callback: () => void;
  }> = [];

  constructor(startAt: Date | number, rate = 1.0) {
    this._startWallMs = Date.now();
    this._virtualStartMs = startAt instanceof Date ? startAt.getTime() : startAt;
    this._rate = rate;
  }

  now(): number {
    return this.timestamp();
  }

  timestamp(): number {
    const wallElapsed = Date.now() - this._startWallMs;
    return this._virtualStartMs + wallElapsed * this._rate;
  }

  /**
   * Instantly advance virtual time by the given number of milliseconds
   * without waiting for real wall time to pass.
   *
   * Also fires any tick callbacks whose interval boundary is crossed.
   * This is used by M2 tests to drive deterministic interval callbacks.
   */
  advance(ms: number): void {
    const prev = this.timestamp();
    this._virtualStartMs += ms;
    const next = this.timestamp();

    // Fire tick callbacks for crossed boundaries (M2 compatibility).
    for (const entry of this._ticks) {
      const prevBucket = Math.floor(prev / entry.intervalMs);
      const newBucket = Math.floor(next / entry.intervalMs);
      const crossings = newBucket - prevBucket;
      if (crossings > 0) {
        for (let i = 0; i < crossings; i++) {
          entry.callback();
        }
        entry.lastFiredAt = next;
      }
    }
  }

  /**
   * Register a callback to be called each time advance() causes the internal
   * clock to cross an intervalMs boundary. Used by M2 straddle-calc and VIX
   * feed in tests to drive periodic callbacks without real timers.
   */
  tick(intervalMs: number, callback: () => void): void {
    this._ticks.push({
      intervalMs,
      lastFiredAt: this.timestamp(),
      callback,
    });
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
    this._virtualStartMs = this.timestamp();
    this._startWallMs = Date.now();
    this._rate = 0;
  }

  /**
   * Resume the virtual clock after a pause.
   */
  resume(rate = 1.0): void {
    this._startWallMs = Date.now();
    this._rate = rate;
  }

  today(): string {
    return _istDateString(this.timestamp());
  }

  toISTDate(epochMs: number): string {
    return _istDateString(epochMs);
  }

  toISTTime(epochMs: number): string {
    return _istTimeString(epochMs);
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

// ---------------------------------------------------------------------------
// ClockWithTick intersection type (M2 compatibility)
// ---------------------------------------------------------------------------

/**
 * Intersection type for clocks that support interval callbacks.
 * Used by M2 StraddleCalculator, VixFeed, MarketDataSimulator, PositionMonitor.
 * VirtualClock satisfies this type via its tick() method.
 */
export type ClockWithTick = Clock & {
  tick(intervalMs: number, callback: () => void): void;
};
