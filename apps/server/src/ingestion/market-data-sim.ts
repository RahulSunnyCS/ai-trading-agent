/**
 * Random-walk NIFTY market data simulator.
 *
 * Implements BrokerFeed so the rest of the system is completely unaware it is
 * talking to a simulator rather than a live broker WebSocket. Enable via
 * SIMULATE=true — no broker credentials required.
 *
 * Price model: Geometric Brownian Motion (GBM), the same model used in
 * Black-Scholes. This keeps the generated prices strictly positive and
 * produces percentage returns that are normally distributed, matching the
 * statistical character of real equity index data over short horizons.
 *
 * Clock injection: the clock parameter is accepted for testability but this
 * implementation uses setInterval directly. For fully deterministic tick
 * output in tests, use VirtualClock-based wiring (see milestones-0-1 branch).
 */

import type { Clock } from '../utils/clock';
import { RealClock } from '../utils/clock';
import { buildOptionSymbol, getAtmStrike, getCurrentExpiry } from './brokers/instrument-registry';
import type { BrokerFeed, BrokerTick } from './brokers/types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SimulatorConfig {
  /** Starting NIFTY spot price (default: 22500) */
  startPrice?: number;
  /** Tick interval in ms (default: 1000 — 1 tick per second) */
  intervalMs?: number;
  /**
   * Annual volatility for random walk (default: 0.18 — 18%, roughly NIFTY
   * historical realised vol over a multi-year window).
   */
  annualVolatility?: number;
  /**
   * Annualised drift (default: 0 — mean-reverting / no trend).
   * Set a small positive value (e.g. 0.08) to simulate a bull-trending day.
   */
  drift?: number;
  /** Injectable clock for deterministic testing (default: RealClock). */
  clock?: Clock;
}

/** Alias for backward compatibility with milestones-0-1 branch code. */
export type SimulatorOptions = SimulatorConfig;

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export class MarketDataSimulator implements BrokerFeed {
  private _price: number;
  private _config: Required<SimulatorConfig>;

  // Registered callbacks — we keep separate arrays so we can call them in
  // registration order without mixing tick and disconnect logic.
  private _tickCallbacks: Array<(tick: BrokerTick) => void> = [];
  private _disconnectCallbacks: Array<(reason: string) => void> = [];

  // Timer handle — typed as ReturnType<typeof setInterval> so it works in
  // both Node and Bun without importing NodeJS-specific globals.
  private _interval: ReturnType<typeof setInterval> | null = null;

  private _connected = false;

  constructor(config: SimulatorConfig = {}) {
    this._config = {
      startPrice: config.startPrice ?? 22_500,
      intervalMs: config.intervalMs ?? 1_000,
      annualVolatility: config.annualVolatility ?? 0.18,
      drift: config.drift ?? 0,
      // Default to the real system clock; tests inject a FixedClock or
      // VirtualClock to make assertions deterministic.
      clock: config.clock ?? new RealClock(),
    };
    this._price = this._config.startPrice;
  }

  // ---------------------------------------------------------------------------
  // BrokerFeed — lifecycle
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    // Guard against double-connect — same contract as real broker adapters
    // where calling connect() twice on a live WebSocket would open a second
    // connection and double-emit every tick.
    if (this._connected) return;
    this._connected = true;
    this._startEmitting();
  }

  async disconnect(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    if (this._interval !== null) {
      clearInterval(this._interval);
      this._interval = null;
    }
    // Notify all disconnect listeners — matches the contract real adapters
    // use so upstream code can react identically (e.g. attempting reconnect).
    for (const cb of this._disconnectCallbacks) {
      cb('simulator stopped');
    }
  }

  // ---------------------------------------------------------------------------
  // BrokerFeed — subscription and callbacks
  // ---------------------------------------------------------------------------

  subscribe(_symbols: string[]): void {
    // The simulator always emits NIFTY50-INDEX ticks regardless of the
    // symbols list. The parameter is accepted (not thrown) so callers can
    // pass the same subscribe() call they use for real broker adapters without
    // branching. Prefixed with _ to satisfy the TypeScript no-unused-parameter
    // check while making the intentional no-op explicit.
  }

  onTick(callback: (tick: BrokerTick) => void): void {
    this._tickCallbacks.push(callback);
  }

  onDisconnect(callback: (reason: string) => void): void {
    this._disconnectCallbacks.push(callback);
  }

  // EventEmitter-style on() for compatibility with milestones-0-1 branch code
  on(event: 'tick', handler: (tick: BrokerTick) => void): this;
  on(event: 'error', handler: (err: Error) => void): this;
  on(event: 'disconnect', handler: (reason: string) => void): this;
  on(event: 'reconnecting', handler: (attempt: number) => void): this;
  on(
    event: 'tick' | 'error' | 'disconnect' | 'reconnecting',
    // biome-ignore lint/suspicious/noExplicitAny: overload signature requires broad handler type
    handler: (arg: any) => void,
  ): this {
    if (event === 'tick') {
      this._tickCallbacks.push(handler as (tick: BrokerTick) => void);
    } else if (event === 'disconnect') {
      this._disconnectCallbacks.push(handler as (reason: string) => void);
    }
    // 'error' and 'reconnecting' are no-ops in the simulator
    return this;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _startEmitting(): void {
    this._interval = setInterval(() => {
      this._price = this._nextPrice();

      const now = this._config.clock.timestamp?.() ?? this._config.clock.now();
      // Round to 2 decimal places — NIFTY is quoted to the paisa.
      const spot = Math.round(this._price * 100) / 100;

      const indexTick: BrokerTick = {
        symbol: 'NSE:NIFTY50-INDEX',
        underlying: 'NIFTY',
        ltp: spot,
        timestamp: now,
        time: now,
        isIndex: true,
        // Synthetic volume: uniform random in [10 000, 60 000) to mimic
        // realistic intraday session volume without modelling microstructure.
        volume: Math.floor(Math.random() * 50_000) + 10_000,
      };

      // Emit the index tick first — unchanged from before (backward compatible).
      for (const cb of this._tickCallbacks) {
        cb(indexTick);
      }

      // Emit synthetic ATM CE and PE option ticks so straddle-calc's priceMap
      // lookup for the ATM legs succeeds and straddle_snapshots are produced.
      // The symbols are built with exactly the same functions straddle-calc uses
      // (buildOptionSymbol / getCurrentExpiry / getAtmStrike from instrument-registry)
      // so the symbol strings are guaranteed to match the lookup keys.
      const expiry = getCurrentExpiry('NIFTY', this._config.clock);
      const atmStrike = getAtmStrike('NIFTY', spot);

      const ceSymbol = buildOptionSymbol('NIFTY', expiry, atmStrike, 'CE');
      const peSymbol = buildOptionSymbol('NIFTY', expiry, atmStrike, 'PE');

      // Expiry as ISO 'YYYY-MM-DD' — BrokerTick.expiry convention (not Fyers
      // compact notation) so any consumer that reads the field gets a safe date string.
      const expiryIso = expiry.toISOString().slice(0, 10);

      const cePrice = this._syntheticOptionPrice(spot, atmStrike, expiry, now, 'CE');
      const pePrice = this._syntheticOptionPrice(spot, atmStrike, expiry, now, 'PE');

      const ceTick: BrokerTick = {
        symbol: ceSymbol,
        underlying: 'NIFTY',
        ltp: cePrice,
        timestamp: now,
        time: now,
        isIndex: false,
        optionType: 'CE',
        strike: atmStrike,
        expiry: expiryIso,
        // Synthetic option OI: realistic intraday OI range for ATM NIFTY options.
        oi: Math.floor(Math.random() * 500_000) + 100_000,
      };

      const peTick: BrokerTick = {
        symbol: peSymbol,
        underlying: 'NIFTY',
        ltp: pePrice,
        timestamp: now,
        time: now,
        isIndex: false,
        optionType: 'PE',
        strike: atmStrike,
        expiry: expiryIso,
        oi: Math.floor(Math.random() * 500_000) + 100_000,
      };

      for (const cb of this._tickCallbacks) {
        cb(ceTick);
        cb(peTick);
      }
    }, this._config.intervalMs);
  }

  /**
   * Compute a plausible synthetic option price for the ATM leg.
   *
   * This is a development simulator approximation — it does NOT need to be
   * financially exact. The goal is that:
   *   (a) Both CE and PE are strictly positive (never zero or negative).
   *   (b) Prices move meaningfully as spot moves.
   *   (c) The CE+PE straddle value is in a realistic NIFTY range (~150–350pt
   *       for a weekly ATM straddle, depending on VIX and DTE).
   *
   * Approximation used: a simplified Black-Scholes-ish formula that captures
   * the two main drivers — moneyness and time value — without requiring the
   * full N(d1)/N(d2) machinery:
   *
   *   intrinsic = max(direction * (spot - strike), 0)
   *   timeValue = sigma * sqrt(dteYears) * spot * TV_SCALE
   *   price     = intrinsic + timeValue
   *
   * where TV_SCALE ≈ 0.4 (empirically tuned so a typical ATM straddle at
   * ~5 DTE with 18% vol sits around ₹200–250pt, which matches typical NIFTY
   * weekly ATM straddle levels).
   *
   * Since this is the ATM strike (strike == round(spot)), intrinsic is usually
   * 0 or a few ticks, so the time-value term dominates — which is correct for
   * an ATM option.
   *
   * The price is floored at 0.05 to prevent negative or zero LTP, which would
   * confuse any downstream consumer that logs or divides by option price.
   */
  private _syntheticOptionPrice(
    spot: number,
    strike: number,
    expiry: Date,
    nowMs: number,
    optionType: 'CE' | 'PE',
  ): number {
    // Days to expiry in trading-year fraction (same normalisation as _nextPrice).
    const TRADING_YEAR_MS = 252 * 6.25 * 3600 * 1000;
    const dteMs = Math.max(expiry.getTime() - nowMs, 0);
    // Floor DTE at 0.25 trading days so same-day expiry still produces a
    // non-zero time value (avoids a degenerate 0-price on expiry Friday morning).
    const dteYears = Math.max(dteMs / TRADING_YEAR_MS, 0.25 / 252);

    const sigma = this._config.annualVolatility;

    // Intrinsic value: the amount the option is in-the-money.
    // For an ATM strike, intrinsic ≈ 0 most of the time (|spot - strike| < 50).
    const direction = optionType === 'CE' ? 1 : -1;
    const intrinsic = Math.max(direction * (spot - strike), 0);

    // Time value: approximation of the BS at-the-money option value.
    // ATM BS ≈ S * sigma * sqrt(T) * 0.3989 (the N'(0) term = 1/sqrt(2π)).
    // We use 0.4 as a round-number substitute for 0.3989 — close enough for
    // a simulator.
    const timeValue = sigma * Math.sqrt(dteYears) * spot * 0.4;

    // Add a small random jitter (±2%) to make successive ticks look like a
    // live market rather than a perfectly smooth curve.
    const jitter = 1 + (Math.random() - 0.5) * 0.04;

    const price = (intrinsic + timeValue) * jitter;

    // Hard floor: option LTP is always at least ₹0.05 (one paisa increment).
    return Math.max(Math.round(price * 100) / 100, 0.05);
  }

  /**
   * Compute the next price using Geometric Brownian Motion (GBM).
   *
   * GBM formula for a single time step:
   *   S(t+dt) = S(t) * exp((mu - 0.5 * sigma^2) * dt + sigma * sqrt(dt) * Z)
   *
   * where:
   *   mu    = annualised drift
   *   sigma = annualised volatility
   *   dt    = time step in years
   *   Z     = standard normal random variable
   *
   * The Ito correction term (−0.5 * sigma²) ensures the expected price path
   * is exp(mu * t) rather than exp((mu + 0.5 * sigma²) * t), which is what
   * you get from naïve additive normal noise.
   *
   * Trading-year normalisation: 252 trading days × 6.25 trading hours × 3600 s
   * = 5,670,000 seconds per year. Using trading-year seconds rather than
   * calendar seconds keeps sigma calibrated against published NIFTY historical
   * volatility figures (which are trading-day based).
   */
  private _nextPrice(): number {
    // Fraction of a trading year represented by one tick interval.
    const dt = this._config.intervalMs / (252 * 6.25 * 3600 * 1000);
    const sigma = this._config.annualVolatility;
    const mu = this._config.drift;

    // Box-Muller transform: convert two uniform [0,1) samples into one
    // standard normal variate. Math.random() returns [0,1); the log is safe
    // because u1 can approach 0 but never reaches it in IEEE 754.
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    return this._price * Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z);
  }
}
