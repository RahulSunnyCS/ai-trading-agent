import { formatInTimeZone } from "date-fns-tz";

// IST = UTC+5:30. All date/time strings returned by this module are in this timezone.
const IST = "Asia/Kolkata";

/**
 * Clock interface — the single contract for time access across the codebase.
 * All production code must depend on this interface, never on Date.now() directly,
 * so that tests can inject a deterministic clock (FixedClock or VirtualClock).
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
}

/**
 * Production clock: delegates to the real system clock.
 * today() / toISTDate() / toISTTime() always reflect wall-clock IST.
 */
export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  today(): string {
    return formatInTimeZone(new Date(), IST, "yyyy-MM-dd");
  }

  toISTDate(ms: number): string {
    return formatInTimeZone(new Date(ms), IST, "yyyy-MM-dd");
  }

  toISTTime(ms: number): string {
    return formatInTimeZone(new Date(ms), IST, "HH:mm:ss");
  }
}

/**
 * Test clock: frozen at a single instant.
 * Accepts either an epoch-ms number or an ISO-8601 string so callers can use
 * whichever form is clearest in their test setup.
 * now() always returns the same value; today/toISTDate/toISTTime derive from it.
 */
export class FixedClock implements Clock {
  private readonly _fixed: number;

  constructor(epochMsOrIso: number | string) {
    // Accept both forms so tests can pass a readable ISO string rather than
    // an opaque millisecond number.
    this._fixed =
      typeof epochMsOrIso === "string" ? new Date(epochMsOrIso).getTime() : epochMsOrIso;
  }

  now(): number {
    return this._fixed;
  }

  today(): string {
    return formatInTimeZone(new Date(this._fixed), IST, "yyyy-MM-dd");
  }

  toISTDate(ms: number): string {
    return formatInTimeZone(new Date(ms), IST, "yyyy-MM-dd");
  }

  toISTTime(ms: number): string {
    return formatInTimeZone(new Date(ms), IST, "HH:mm:ss");
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
 */
export class VirtualClock implements Clock {
  private _current: number;
  private readonly _ticks: TickEntry[] = [];

  constructor(startEpochMs: number) {
    this._current = startEpochMs;
  }

  now(): number {
    return this._current;
  }

  today(): string {
    return formatInTimeZone(new Date(this._current), IST, "yyyy-MM-dd");
  }

  toISTDate(ms: number): string {
    return formatInTimeZone(new Date(ms), IST, "yyyy-MM-dd");
  }

  toISTTime(ms: number): string {
    return formatInTimeZone(new Date(ms), IST, "HH:mm:ss");
  }

  /**
   * Advances the internal clock by the given number of milliseconds and fires
   * any tick callbacks whose interval boundary has been crossed.
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
}
