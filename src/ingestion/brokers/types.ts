/**
 * BrokerFeed interface + tick types
 *
 * This file contains ONLY type/interface/enum definitions.
 * No implementation logic lives here — adapters (Fyers, AngelOne, simulator)
 * each implement BrokerFeed in their own files and import from here.
 */

/**
 * A single market data tick emitted by any broker adapter.
 *
 * The interface is a union of the two branch conventions:
 * - `symbol` and `ltp` are common to both branches.
 * - `time` (epoch ms) is from milestones-0-1; `timestamp` is from the payment branch.
 *   Both are present so adapters from either branch compile without changes.
 * - Option-specific fields (optionType, strike, expiry) are optional because the
 *   same interface covers both option ticks and index-spot / VIX ticks.
 * - `isIndex` is from milestones-0-1; adapters that don't set it can omit it.
 */
export interface BrokerTick {
  /** Full Fyers-style symbol, e.g. 'NSE:NIFTY50-INDEX'. */
  symbol: string;
  /** Last traded price. */
  ltp: number;
  /** Wall-clock timestamp in epoch milliseconds (milestones-0-1 convention). */
  time?: number;
  /** Wall-clock timestamp in epoch milliseconds (payment-branch convention). */
  timestamp?: number;
  /** Traded volume for the session. */
  volume?: number;
  /** Open interest (contracts). */
  oi?: number;
  /** Best bid price. */
  bid?: number;
  /** Best ask price. */
  ask?: number;
  /** Underlying instrument name: 'NIFTY' | 'BANKNIFTY' | 'SENSEX'. */
  underlying?: string;
  /** 'CE' or 'PE'; undefined for index/VIX ticks. */
  optionType?: 'CE' | 'PE';
  /** Strike price in points; undefined for index/VIX ticks. */
  strike?: number;
  /**
   * Expiry date in 'YYYY-MM-DD' format; undefined for index/VIX ticks.
   * ISO format is used (not Fyers symbol notation) so comparisons are
   * calendar-safe across month-code encoding quirks.
   */
  expiry?: string;
  /** true for index spot ticks (NIFTY spot, VIX) — false for option ticks. */
  isIndex?: boolean;
  /**
   * Exchange-side timestamp in epoch milliseconds, taken directly from the
   * broker's tick payload (Fyers: tick.timestamp × 1000, since Fyers sends
   * epoch seconds).
   *
   * Kept separate from `time` (which is always clock.now()) so that:
   *  - Replay / backtest harnesses can restore the original exchange event
   *    ordering without touching wall-clock references.
   *  - Any latency measurement between exchange event and our processing can
   *    be computed as `time - exchangeTime`.
   *
   * Optional so other producers (simulator, AngelOne stub) need not set it.
   */
  exchangeTime?: number;
}

/**
 * Common interface every broker adapter must implement.
 *
 * Supports two event registration styles:
 *  - on(event, handler) — EventEmitter style (milestones-0-1 branch pattern)
 *  - onTick(callback) / onDisconnect(callback) — callback style (payment branch pattern)
 *
 * New adapters should implement both styles for maximum compatibility.
 */
export interface BrokerFeed {
  /** Open the WebSocket / streaming connection to the broker. */
  connect(): Promise<void>;

  /**
   * Subscribe to market data for the given list of broker-format symbols.
   * May be called after connect() — or re-called to add symbols.
   * Returns void or Promise<void> depending on the adapter.
   */
  subscribe(symbols: string[]): void | Promise<void>;

  /** Gracefully close the connection. */
  disconnect(): Promise<void>;

  /**
   * Register a handler for incoming tick data (callback style).
   * Multiple callbacks may be registered; all are called in registration order.
   */
  onTick?(callback: (tick: BrokerTick) => void): void;

  /**
   * Register a handler for disconnection events (callback style).
   */
  onDisconnect?(callback: (reason: string) => void): void;

  /** Register a handler for incoming tick data (EventEmitter style). */
  on?(event: 'tick', handler: (tick: BrokerTick) => void): this;
  /** Register a handler for feed-level errors (EventEmitter style). */
  on?(event: 'error', handler: (err: Error) => void): this;
  /** Register a handler for disconnection events (EventEmitter style). */
  on?(event: 'disconnect', handler: (reason: string) => void): this;
  /** Register a handler for reconnection attempts (EventEmitter style). */
  on?(event: 'reconnecting', handler: (attempt: number) => void): this;
}

/**
 * Identifies which broker adapter is active.
 * Used by the factory / selection logic in src/ingestion/brokers/index.ts.
 */
export type BrokerName = 'fyers' | 'angelone' | 'simulator';

/**
 * Structured disconnect reason codes.
 *
 * String enum values (not numeric) are used so log output is self-describing
 * without a lookup table — important for fast debugging of silent
 * Fyers token-expiry disconnects.
 */
export enum DisconnectReason {
  /** Token expired or credentials rejected by the broker. */
  AUTH_FAILURE = 'AUTH_FAILURE',
  /** Network blip or broker-side transient failure — reconnect is appropriate. */
  TRANSIENT = 'TRANSIENT',
  /** disconnect() was called intentionally — do not reconnect. */
  MANUAL = 'MANUAL',
}

/**
 * Fyers month codes for weekly option symbol construction.
 * Jan–Sep are '1'–'9'; Oct–Dec are 'O', 'N', 'D'.
 * Used by instrument-registry.ts and exported here so types.ts is the
 * single source of truth for the encoding.
 */
export const MONTH_CODES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'O', 'N', 'D'] as const;
export type MonthCode = (typeof MONTH_CODES)[number];

/** Underlying symbols for the three supported indices */
export const UNDERLYING_SYMBOLS = {
  NIFTY: 'NSE:NIFTY50-INDEX',
  BANKNIFTY: 'NSE:NIFTYBANK-INDEX',
  SENSEX: 'BSE:SENSEX-INDEX',
} as const;

export type Underlying = keyof typeof UNDERLYING_SYMBOLS;
