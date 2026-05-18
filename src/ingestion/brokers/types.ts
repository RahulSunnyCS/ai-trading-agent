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
 * optionType, strike, and expiry are optional because the same interface
 * covers both option ticks and index-spot / VIX ticks (which have no
 * option-specific fields). Callers must check isIndex and optionType
 * before accessing those fields.
 */
export interface BrokerTick {
  /** Wall-clock timestamp in epoch milliseconds. */
  time: number;
  /** Full Fyers-style symbol, e.g. 'NSE:NIFTY24O17023000CE'. */
  symbol: string;
  /** Underlying instrument name: 'NIFTY' | 'BANKNIFTY' | 'SENSEX'. */
  underlying: string;
  /** Last traded price. */
  ltp: number;
  /** Best bid price. */
  bid: number;
  /** Best ask price. */
  ask: number;
  /** Traded volume for the session. */
  volume: number;
  /** Open interest (contracts). */
  oi: number;
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
  isIndex: boolean;
}

/**
 * Common interface every broker adapter must implement.
 *
 * The overloaded on() signatures mirror the Node.js EventEmitter pattern
 * but are declared explicitly here so TypeScript enforces the exact event
 * names and payload types at each call site — rather than accepting
 * arbitrary strings with `any` handlers.
 *
 * Returning `this` from on() allows fluent chaining:
 *   feed.on('tick', handleTick).on('error', handleError)
 */
export interface BrokerFeed {
  /** Open the WebSocket / streaming connection to the broker. */
  connect(): Promise<void>;
  /**
   * Subscribe to market data for the given list of broker-format symbols
   * (e.g. ['NSE:NIFTY24O17023000CE', 'NSE:NIFTY-INDEX']).
   * May be called after connect() — or re-called to add symbols.
   */
  subscribe(symbols: string[]): Promise<void>;
  /** Gracefully close the connection. */
  disconnect(): Promise<void>;
  /** Register a handler for incoming tick data. */
  on(event: 'tick', handler: (tick: BrokerTick) => void): this;
  /** Register a handler for feed-level errors. */
  on(event: 'error', handler: (err: Error) => void): this;
  /**
   * Register a handler for disconnection events.
   * reason is a human-readable string; use DisconnectReason constants
   * for programmatic branching.
   */
  on(event: 'disconnect', handler: (reason: string) => void): this;
  /** Register a handler for reconnection attempts (receives attempt count). */
  on(event: 'reconnecting', handler: (attempt: number) => void): this;
}

/**
 * Identifies which broker adapter is active.
 * Used by the factory / selection logic in src/index.ts.
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
