/**
 * BrokerFeed interface + tick types
 *
 * This file contains ONLY type/interface/enum definitions.
 * No implementation logic lives here — adapters (Fyers, AngelOne, simulator)
 * each implement BrokerFeed in their own files and import from here.
 */

/**
 * Canonical market tick emitted by any broker adapter.
 * All numeric fields are in the broker's native units (INR for Indian markets).
 */
export interface BrokerTick {
  symbol: string; // Fyers symbol format: 'NSE:NIFTY50-INDEX', 'NSE:NIFTY25JUN24500CE'
  ltp: number; // Last traded price
  timestamp: number; // Unix ms (epoch milliseconds)
  volume?: number; // Total traded volume for the session (optional — not all feeds provide it)
  oi?: number; // Open interest (options only)
  bid?: number; // Best bid price
  ask?: number; // Best ask price
}

/**
 * Implemented by every broker adapter (Fyers, AngelOne, simulator).
 * The trading engine only knows about BrokerFeed — never about a specific broker class.
 */
export interface BrokerFeed {
  /**
   * Start the feed. Resolves when the connection is established and
   * the feed is ready to emit ticks. Rejects on unrecoverable error.
   */
  connect(): Promise<void>;

  /**
   * Subscribe to tick updates for the given symbols.
   * May be called after connect() or before — implementations buffer as needed.
   * @param symbols Array of Fyers-format symbol strings
   */
  subscribe(symbols: string[]): void;

  /**
   * Register a callback invoked for every tick received.
   * Multiple callbacks may be registered; all are called in registration order.
   */
  onTick(callback: (tick: BrokerTick) => void): void;

  /**
   * Register a callback invoked when the feed disconnects (intentional or error).
   * Implementations should call this before attempting reconnect.
   */
  onDisconnect(callback: (reason: string) => void): void;

  /**
   * Gracefully stop the feed. Resolves when the underlying connection is closed.
   */
  disconnect(): Promise<void>;
}

/**
 * Symbol format helpers — Fyers uses a specific encoding for options.
 * NSE weekly options: NSE:NIFTY{YY}{M}{DD}{STRIKE}{TYPE}
 * where months Oct-Dec use single letters: O, N, D
 * Examples:
 *   NSE:NIFTY24J2524500CE  — NIFTY Jan 25 2024 24500 Call
 *   NSE:NIFTY24O1024500PE  — NIFTY Oct 10 2024 24500 Put
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

/**
 * Identifies which broker adapter is active.
 * Used by the factory / selection logic.
 */
export type BrokerName = 'fyers' | 'angelone' | 'simulator';
