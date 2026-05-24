import { formatInTimeZone } from 'date-fns-tz';

// IST = UTC+5:30. All date/time strings returned by this module are in this timezone.
const IST = 'Asia/Kolkata';

/**
 * IST is UTC+5:30 — a fixed offset with no daylight-saving transitions.
 * Stored in milliseconds for use in timestamp arithmetic.
 */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Clock interface — the single contract for time access across the codebase.
 * All production code must depend on this interface, never on Date.now() directly,
 * so that tests can inject a deterministic clock (FixedClock or VirtualClock).
 *
 * This interface merges both branches' conventions:
 *   - now(): number    — epoch milliseconds (milestones-0-1 convention)
 *   - today(): string  — IST date string 'YYYY-MM-DD' (milestones-0-1)
 *   - timestamp(): number — alias for now() (payment-branch convention)
 *   - toISTDate/toISTTime — IST conversion helpers (milestones-0-1)
 */
export interface Clock {
  /** Returns the current timestamp as epoch milliseconds. */
  now(): number;
  /** Returns today's date in IST as 'YYYY-MM-DD'. */
  today(): string;
  /** Converts an epoch-ms timestamp to an IST date string 'YYYY-MM-DD'. */
  toISTDate(ms: number): string;
  /** Converts an epoch-ms timestamp to an IST time string 'HH:mm:ss'. */
  toISTTime(ms: number): string;
  /**
   * Returns the current timestamp as epoch milliseconds.
   * Alias for now() — added for compatibility with the payment branch's
   * Clock interface which uses timestamp() instead of now().
   */
  timestamp(): number;
}

/**
 * Production clock: delegates to the real system clock.
 * today() / toISTDate() / toISTTime() always reflect wall-clock IST.
 */
export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  timestamp(): number {
    return Date.now();
  }

  today(): string {
    return formatInTimeZone(new Date(), IST, 'yyyy-MM-dd');
  }

  toISTDate(ms: number): string {
    return formatInTimeZone(new Date(ms), IST, 'yyyy-MM-dd');
  }

  toISTTime(ms: number): string {
    return formatInTimeZone(new Date(ms), IST, 'HH:mm:ss');
  }
}

/**
 * Test clock: frozen at a single instant.
 * Accepts either an epoch-ms number or an ISO-8601 string so callers can use
 * whichever form is clearest in their test setup.
 * now() / timestamp() always return the same value; today/toISTDate/toISTTime derive from it.
 */
export class FixedClock implements Clock {
  private readonly _fixed: number;

  constructor(epochMsOrIso: number | string | Date) {
    // Accept epoch ms, ISO string, or Date object so tests can pass whichever
    // form is clearest.  The Date form is added for payment-branch compatibility
    // where FixedClock was constructed with `new FixedClock(new Date(...))`.
    if (epochMsOrIso instanceof Date) {
      this._fixed = epochMsOrIso.getTime();
    } else if (typeof epochMsOrIso === 'string') {
      this._fixed = new Date(epochMsOrIso).getTime();
    } else {
      this._fixed = epochMsOrIso;
    }
  }

  now(): number {
    return this._fixed;
  }

  timestamp(): number {
    return this._fixed;
  }

  today(): string {
    return formatInTimeZone(new Date(this._fixed), IST, 'yyyy-MM-dd');
  }

  toISTDate(ms: number): string {
    return formatInTimeZone(new Date(ms), IST, 'yyyy-MM-dd');
  }

  toISTTime(ms: number): string {
    return formatInTimeZone(new Date(ms), IST, 'HH:mm:ss');
  }
}

/**
 * Intersection type for clocks that support interval callbacks.
 * Used by StraddleCalculator, VixFeed, MarketDataSimulator, PositionMonitor,
 * and broker-factory — all of which need the real Clock interface plus the
 * ability to register interval callbacks driven by VirtualClock.advance() in tests.
 *
 * Exported here so it is defined exactly once; all modules import from this file.
 */
export type ClockWithTick = Clock & {
  tick(intervalMs: number, callback: () => void): void;
};

/**
 * Represents a single registered tick callback.
 * We store the intervalMs and the timestamp at which it was last "fired" so we
 * can detect boundary crossings independently for each callback.
 */
interface TickEntry {
  intervalMs: number;
  lastFiredAt: number; // the internal timestamp at the point of registration
  callback: () => void;
}

/**
 * Deterministic simulation clock.
 * Time advances only when advance() is called explicitly — no wall-clock involvement.
 * tick() registers callbacks that are fired each time advance() causes the internal
 * timestamp to cross an interval boundary.
 *
 * Boundary semantics:
 *   A boundary is crossed when floor(newTime / intervalMs) > floor(lastFiredAt / intervalMs).
 *   Callbacks fire once per boundary crossed, not once per advance() call.
 *   If a single advance() skips multiple boundaries, the callback fires once for each
 *   boundary crossed (this mirrors real timer behaviour for large jumps in simulation).
 *
 * Why track lastFiredAt at the moment of registration (not at the first advance)?
 *   So that a callback registered at t=0 with interval=1000 fires the first time
 *   advance() pushes the clock to >= 1000, not at t=0 itself.
 *
 * The payment branch also had a VirtualClock with advance()/pause()/resume()/setRate()
 * for wall-time-proportional replay.  Those methods are included below for compatibility.
 */
export class VirtualClock implements Clock {
  private _current: number;
  private readonly _ticks: TickEntry[] = [];

  // Payment-branch replay fields: track wall-clock anchor for rate-based advance.
  // When _rate is 0 (default), advance() is purely manual (milestones-0-1 behaviour).
  private _startWallMs: number;
  private _rate: number;

  constructor(startEpochMsOrDate: number | Date, rate = 0) {
    // Accept both number (milestones-0-1) and Date (payment branch) for the start value.
    this._current =
      startEpochMsOrDate instanceof Date ? startEpochMsOrDate.getTime() : startEpochMsOrDate;
    this._rate = rate;
    this._startWallMs = Date.now();
  }

  now(): number {
    // If rate > 0, virtual time advances proportionally with wall time.
    // If rate is 0, virtual time only moves via explicit advance() calls.
    if (this._rate > 0) {
      const wallElapsed = Date.now() - this._startWallMs;
      return this._current + wallElapsed * this._rate;
    }
    return this._current;
  }

  timestamp(): number {
    return this.now();
  }

  today(): string {
    return formatInTimeZone(new Date(this.now()), IST, 'yyyy-MM-dd');
  }

  toISTDate(ms: number): string {
    return formatInTimeZone(new Date(ms), IST, 'yyyy-MM-dd');
  }

  toISTTime(ms: number): string {
    return formatInTimeZone(new Date(ms), IST, 'HH:mm:ss');
  }

  /**
   * Advances the internal clock by the given number of milliseconds and fires
   * any tick callbacks whose interval boundary has been crossed.
   *
   * This is the primary mechanism for deterministic test advancement.
   */
  advance(ms: number): void {
    const prev = this._current;
    this._current = prev + ms;

    for (const entry of this._ticks) {
      // How many boundaries the window [prev+1 .. current] crosses.
      // We use integer division to count completed intervals.
      const prevBucket = Math.floor(prev / entry.intervalMs);
      const newBucket = Math.floor(this._current / entry.intervalMs);
      const crossings = newBucket - prevBucket;

      if (crossings > 0) {
        // Fire exactly once per boundary crossed (supports big jumps).
        for (let i = 0; i < crossings; i++) {
          entry.callback();
        }
        // Update lastFiredAt so the next advance() calculates from the right
        // baseline. We set it to the current timestamp so prevBucket is
        // recomputed correctly on the next call.
        entry.lastFiredAt = this._current;
      }
    }
  }

  /**
   * Registers a callback to be called each time advance() causes the internal
   * clock to cross an intervalMs boundary.  Multiple callbacks can be
   * registered at different (or the same) intervals.
   */
  tick(intervalMs: number, callback: () => void): void {
    this._ticks.push({
      intervalMs,
      lastFiredAt: this._current,
      callback,
    });
  }

  /**
   * Change the replay rate without resetting virtual time.
   * Re-anchors the wall-clock reference so virtual time accumulated so far
   * is preserved and future elapsed is computed correctly from this moment.
   */
  setRate(rate: number): void {
    this._current = this.now();
    this._startWallMs = Date.now();
    this._rate = rate;
  }

  /**
   * Pause the virtual clock (rate = 0). Virtual time stops advancing
   * proportionally with wall time.  Call resume() to continue.
   */
  pause(): void {
    this._current = this.now();
    this._startWallMs = Date.now();
    this._rate = 0;
  }

  /**
   * Resume the virtual clock after a pause.
   * The wall-clock reference is reset to now so time spent paused does not
   * count as elapsed virtual time.
   */
  resume(rate = 1.0): void {
    this._startWallMs = Date.now();
    this._rate = rate;
  }
}

// ---------------------------------------------------------------------------
// Factory function (payment-branch addition)
// ---------------------------------------------------------------------------

/**
 * Convenience factory — returns the correct Clock implementation based on
 * the supplied options:
 *   - options.fixed   → FixedClock (unit tests)
 *   - options.virtual → VirtualClock (replay / backtesting)
 *   - no options      → RealClock (production)
 */
export function createClock(options?: {
  fixed?: Date | number;
  virtual?: { startAt: Date | number; rate?: number };
}): Clock {
  if (options?.fixed !== undefined) return new FixedClock(options.fixed);
  if (options?.virtual !== undefined) {
    return new VirtualClock(options.virtual.startAt, options.virtual.rate);
  }
  return new RealClock();
}

// ---------------------------------------------------------------------------
// IST helpers (payment-branch additions)
// ---------------------------------------------------------------------------

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
