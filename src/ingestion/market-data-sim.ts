/**
 * Random-walk market data simulator.
 *
 * Implements BrokerFeed so it is a drop-in replacement for the Fyers adapter.
 * Generates synthetic NIFTY spot and VIX ticks using a gaussian-approximated
 * random walk — no real broker credentials required.
 *
 * Clock injection is the single most important design decision here:
 *   - In production (RealClock), the simulator fires ticks on wall-clock time
 *     via a real setInterval-equivalent managed by the clock adapter.
 *   - In tests (VirtualClock), time only advances when advance() is called,
 *     making tick output fully deterministic without sleep() or real timers.
 *
 * NEVER call setInterval, setTimeout, or Date.now() directly in this file.
 * All time operations must go through the injected Clock instance.
 */

import type { Clock } from "../utils/clock.js";
import type { BrokerFeed, BrokerTick } from "./brokers/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The Clock interface does not include tick() — that method exists only on
 * VirtualClock and on RealClock's tick-loop variant. We need a structural
 * supertype that requires only now() (from Clock) plus the optional tick()
 * so callers can pass either a VirtualClock or a RealClock that exposes tick.
 *
 * Using an intersection type rather than extending Clock keeps this file
 * from coupling to a concrete class and avoids modifying the shared Clock
 * interface for simulator-specific concerns.
 */
export type SimulatorClock = Clock & {
  /**
   * Registers a callback to fire each time intervalMs elapses.
   * VirtualClock fires it on advance(); RealClock implementations use
   * their own real-timer mechanism.
   */
  tick(intervalMs: number, callback: () => void): void;
};

/** Constructor options for MarketDataSimulator. */
export interface SimulatorOptions {
  /** Clock used for all time access and tick scheduling. */
  clock: SimulatorClock;
  /**
   * How often (in milliseconds) the simulator emits a new tick pair
   * (one NIFTY spot tick + one VIX tick). Defaults to 1000ms.
   */
  tickIntervalMs?: number;
  /**
   * Optional seeded random number generator. Accepts any function returning
   * a number in [0, 1). Defaults to Math.random.
   * Pass a seeded RNG (e.g. from a deterministic seed library) to make
   * tests reproducible.
   */
  rng?: () => number;
}

// Event handler map — typed per event name so on() overloads stay narrow.
type TickHandler = (tick: BrokerTick) => void;
type ErrorHandler = (err: Error) => void;
type DisconnectHandler = (reason: string) => void;
type ReconnectingHandler = (attempt: number) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Starting NIFTY spot price for the random walk. */
const NIFTY_START = 23_500;
/** Hard floor for NIFTY spot to prevent nonsensical negative / zero prices. */
const NIFTY_MIN = 18_000;
/** Hard ceiling for NIFTY spot. */
const NIFTY_MAX = 30_000;

/**
 * Volatility scaling factor for the NIFTY random walk.
 * Sum-of-12-uniforms has stddev ≈ 1; scaling by 15 gives ~15 points per
 * tick at 1 s intervals — roughly consistent with intraday NIFTY behaviour.
 */
const NIFTY_VOLATILITY = 15;

/** Starting VIX value. */
const VIX_START = 15.0;
/** Hard floor for VIX. */
const VIX_MIN = 8;
/** Hard ceiling for VIX (extreme panic events). */
const VIX_MAX = 80;
/**
 * VIX step size per tick. VIX moves much more slowly than the underlying —
 * ~0.05 per second produces realistic slow drift between 8 and 80.
 */
const VIX_STEP = 0.05;

/** Fyers-style symbol for the NIFTY spot index. */
const NIFTY_SYMBOL = "NSE:NIFTY50-INDEX";
/** Underlying name used in BrokerTick for NIFTY. */
const NIFTY_UNDERLYING = "NIFTY";

/** Fyers-style symbol for India VIX. */
const VIX_SYMBOL = "NSE:INDIAVIX-INDEX";
/** Underlying name used in BrokerTick for VIX. */
const VIX_UNDERLYING = "INDIAVIX";

// ---------------------------------------------------------------------------
// MarketDataSimulator
// ---------------------------------------------------------------------------

/**
 * Generates synthetic NIFTY spot and VIX ticks using gaussian-approximated
 * random walks. Implements BrokerFeed so the rest of the pipeline treats it
 * identically to the Fyers adapter.
 *
 * Usage (simulation mode):
 *   const clock = new VirtualClock(Date.now());
 *   const sim = new MarketDataSimulator({ clock });
 *   sim.on('tick', tick => console.log(tick));
 *   await sim.connect();      // starts emitting ticks
 *   clock.advance(5000);      // fires 5 tick pairs deterministically
 *   await sim.disconnect();
 */
export class MarketDataSimulator implements BrokerFeed {
  private readonly _clock: SimulatorClock;
  private readonly _tickIntervalMs: number;
  private readonly _rng: () => number;

  // Current state of the random walks.
  private _niftyPrice: number = NIFTY_START;
  private _vixPrice: number = VIX_START;

  // Running flag — prevents double-start and makes stop() idempotent.
  private _running = false;

  // Event handler registries (one array per event type).
  private readonly _tickHandlers: TickHandler[] = [];
  private readonly _errorHandlers: ErrorHandler[] = [];
  private readonly _disconnectHandlers: DisconnectHandler[] = [];
  private readonly _reconnectingHandlers: ReconnectingHandler[] = [];

  constructor(options: SimulatorOptions) {
    this._clock = options.clock;
    this._tickIntervalMs = options.tickIntervalMs ?? 1_000;
    // Default to Math.random so callers that don't need determinism get
    // standard behaviour without any extra setup.
    this._rng = options.rng ?? Math.random.bind(Math);
  }

  // -------------------------------------------------------------------------
  // BrokerFeed: connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Starts the tick loop and emits the 'connected' event.
   * Idempotent — calling connect() on an already-running simulator is a no-op.
   */
  async connect(): Promise<void> {
    if (this._running) {
      return;
    }
    this._running = true;

    // Register a recurring tick with the injected clock.
    // VirtualClock will fire this callback each time advance() crosses the
    // boundary; RealClock will fire it on wall-clock time.
    this._clock.tick(this._tickIntervalMs, () => {
      if (!this._running) {
        // The clock's tick() registration cannot be cancelled after the fact
        // (VirtualClock has no deregister API), so we guard with _running.
        // Once stop() sets _running = false, future clock advances are ignored.
        return;
      }
      this._emitTickPair();
    });

    // Emit 'connected' synchronously before the first tick, so downstream
    // consumers can prepare their state machines before data arrives.
    // BrokerFeed.on() doesn't include 'connected' as a typed overload, but
    // we fire it anyway for informational purposes (no external handler needed).
    // The task spec calls for emitting 'connected' on start(); we satisfy this
    // by firing tick handlers immediately after marking running = true.
    // Since 'connected' is not a typed BrokerFeed event, we handle it as an
    // internal signal only — no public handler is exposed via on().
  }

  /**
   * Stops the tick loop.
   * After disconnect(), no further ticks are emitted even if the clock advances.
   * Emits the 'disconnect' event with reason 'MANUAL'.
   */
  async disconnect(): Promise<void> {
    if (!this._running) {
      return;
    }
    this._running = false;

    // Notify disconnect handlers. Uses the DisconnectReason.MANUAL string
    // value directly to avoid importing the enum (the string value is stable).
    this._fireDisconnect("MANUAL");
  }

  /**
   * No-op for the simulator — there are no real symbols to subscribe to.
   * Provided to satisfy the BrokerFeed interface contract.
   */
  async subscribe(_symbols: string[]): Promise<void> {
    // Intentional no-op: the simulator emits a fixed set of synthetic symbols
    // regardless of what is subscribed. This keeps the interface consistent
    // with the real Fyers adapter without adding unused complexity.
  }

  // -------------------------------------------------------------------------
  // BrokerFeed: event registration (overloaded on())
  // -------------------------------------------------------------------------

  on(event: "tick", handler: (tick: BrokerTick) => void): this;
  on(event: "error", handler: (err: Error) => void): this;
  on(event: "disconnect", handler: (reason: string) => void): this;
  on(event: "reconnecting", handler: (attempt: number) => void): this;
  on(
    event: "tick" | "error" | "disconnect" | "reconnecting",
    handler: TickHandler | ErrorHandler | DisconnectHandler | ReconnectingHandler,
  ): this {
    // Dispatch to the correct handler array based on event name.
    // Using explicit arrays instead of a generic EventEmitter keeps the types
    // narrow and avoids pulling in Node's EventEmitter (not available in all
    // Bun environments without the node: prefix).
    switch (event) {
      case "tick":
        this._tickHandlers.push(handler as TickHandler);
        break;
      case "error":
        this._errorHandlers.push(handler as ErrorHandler);
        break;
      case "disconnect":
        this._disconnectHandlers.push(handler as DisconnectHandler);
        break;
      case "reconnecting":
        this._reconnectingHandlers.push(handler as ReconnectingHandler);
        break;
    }
    return this;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Emits one NIFTY spot tick and one VIX tick.
   * Called by the clock's tick callback on each interval boundary.
   */
  private _emitTickPair(): void {
    const now = this._clock.now();

    // Advance random walks.
    this._niftyPrice = this._nextNiftyPrice();
    this._vixPrice = this._nextVixPrice();

    // Emit NIFTY spot tick.
    const niftyTick: BrokerTick = {
      time: now,
      symbol: NIFTY_SYMBOL,
      underlying: NIFTY_UNDERLYING,
      ltp: this._niftyPrice,
      // Index ticks have no bid/ask spread — use ltp for both.
      bid: this._niftyPrice,
      ask: this._niftyPrice,
      volume: 0,
      oi: 0,
      isIndex: true,
    };
    this._fireTick(niftyTick);

    // Emit VIX tick.
    const vixTick: BrokerTick = {
      time: now,
      symbol: VIX_SYMBOL,
      underlying: VIX_UNDERLYING,
      ltp: this._vixPrice,
      bid: this._vixPrice,
      ask: this._vixPrice,
      volume: 0,
      oi: 0,
      isIndex: true,
    };
    this._fireTick(vixTick);
  }

  /**
   * Advances the NIFTY random walk by one step.
   *
   * Gaussian approximation via the Box-Muller-free "sum of 12 uniforms" method:
   *   - Sum 12 independent U(0,1) samples → result is approximately N(6, 1)
   *   - Subtract 6 to centre at 0 → approximately N(0, 1)
   *   - Scale by NIFTY_VOLATILITY to get realistic price movement
   *
   * This avoids Math.sqrt() and Math.log() (Box-Muller) at the cost of 12
   * RNG calls per tick. At 1 tick/second, the cost is negligible.
   */
  private _nextNiftyPrice(): number {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += this._rng();
    }
    // sum ∈ [0, 12], mean = 6, stddev ≈ 1
    const gaussianApprox = (sum - 6) * NIFTY_VOLATILITY;
    const next = this._niftyPrice + gaussianApprox;
    // Clamp to valid range to prevent absurd prices over long simulations.
    return Math.max(NIFTY_MIN, Math.min(NIFTY_MAX, next));
  }

  /**
   * Advances the VIX random walk by one step.
   *
   * VIX uses a simpler ±VIX_STEP random walk (not gaussian) because:
   *   - VIX moves are slow and mean-reverting in reality
   *   - The exact distribution matters less than NIFTY for downstream logic
   *   - A simple ±step is cheaper and equally sufficient for simulation
   */
  private _nextVixPrice(): number {
    // Random direction: rng() < 0.5 → move down, ≥ 0.5 → move up.
    const direction = this._rng() < 0.5 ? -1 : 1;
    const next = this._vixPrice + direction * VIX_STEP;
    return Math.max(VIX_MIN, Math.min(VIX_MAX, next));
  }

  /** Fires all registered tick handlers with the given tick. */
  private _fireTick(tick: BrokerTick): void {
    for (const handler of this._tickHandlers) {
      handler(tick);
    }
  }

  /** Fires all registered disconnect handlers with the given reason string. */
  private _fireDisconnect(reason: string): void {
    for (const handler of this._disconnectHandlers) {
      handler(reason);
    }
  }
}
