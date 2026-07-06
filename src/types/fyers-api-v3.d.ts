/**
 * TypeScript declarations for the fyers-api-v3 SDK (CommonJS, untyped).
 *
 * These declarations cover only the surface used by this codebase:
 * fyersDataSocket for market data subscriptions. The full SDK includes
 * fyersModel (REST API), fyersOrderSocket, and fyersTbtSocket — those
 * are intentionally omitted here to keep the shim minimal and auditable.
 *
 * Actual SDK behaviour (from README + sample inspection):
 *   - fyersDataSocket.getInstance() takes a combined "APPID:AccessToken"
 *     string as the first argument. Our adapter concatenates appId and
 *     accessToken before calling it.
 *   - The socket object returned is an EventEmitter-like object with the
 *     methods and events listed below.
 *   - The SDK is CommonJS — import via createRequire or the defensive
 *     pattern used in fyers.ts.
 *
 * NOTE: The payment branch declared fyersDataSocket as a class with a
 * constructor. The actual SDK uses a factory pattern (getInstance), not a
 * constructor. The class declaration below is kept as an additional export
 * shape for compatibility with any import that references the class form,
 * but production code should use the factory interface.
 */

declare module 'fyers-api-v3' {
  /**
   * A Fyers data socket instance returned by fyersDataSocket.getInstance().
   *
   * Event semantics (from SDK README):
   *   - "connect"  — emitted when the WebSocket handshake succeeds
   *   - "message"  — emitted for every incoming tick; payload is the decoded tick object
   *   - "error"    — emitted on auth failure (code 1) or protocol errors
   *   - "close"    — emitted when the connection is closed (cleanly or not)
   */
  interface FyersDataSocketInstance {
    /** Register an event handler. */
    on(event: 'connect', handler: () => void): this;
    on(event: 'message', handler: (tick: FyersTick) => void): this;
    on(event: 'error', handler: (err: FyersSocketError) => void): this;
    on(event: 'close', handler: () => void): this;
    on(event: string, handler: (...args: unknown[]) => void): this;

    /** Subscribe to market data for the given Fyers symbol strings. */
    subscribe(symbols: string[]): void;

    /** Unsubscribe from market data for the given Fyers symbol strings. */
    unsubscribe(symbols: string[]): void;

    /** Open the WebSocket connection. Must be called after wiring up event handlers. */
    connect(): void;

    /**
     * Enable the SDK's built-in auto-reconnect with the given retry count.
     * We handle reconnection ourselves (with exponential backoff) and call
     * autoreconnect(false) (or no-arg) to disable the built-in mechanism so
     * we have full control over retry timing.
     *
     * Passing no arguments or false disables; passing a number enables with
     * that many retry attempts.
     */
    autoreconnect(status?: number | boolean): void;

    /** Close the WebSocket connection. */
    close(): void;

    /** Switch to full-depth data mode. Available as a property on the instance. */
    FullMode: number;
    /** Switch to lite (LTP-only) data mode. */
    LiteMode: number;

    /** Set the data mode on one or more channels. */
    mode(mode: number, channel?: number | number[]): void;
  }

  /**
   * Shape of a decoded tick message from the Fyers data socket.
   *
   * Fields are optional because Fyers emits partial ticks — not all fields
   * are present in every message (e.g., OI is absent for index spot ticks).
   * The adapter normalises these to safe defaults (0) when mapping to BrokerTick.
   */
  interface FyersTick {
    /** Fyers symbol string, e.g. 'NSE:NIFTY50-INDEX'. */
    symbol?: string;
    /** Last traded price. */
    ltp?: number;
    /** Volume traded today. Some ticks emit this as vol_traded_today. */
    vol_traded_today?: number;
    /** Volume (alternate field name). */
    v?: number;
    /** Open interest. Absent on index/spot ticks. */
    oi?: number;
    /** Best bid price. */
    bid_price?: number;
    /** Best ask price. */
    ask_price?: number;
    /** Change in price from previous close. */
    ch?: number;
    /** Change percentage. */
    chp?: number;
    /** Timestamp as epoch seconds (Fyers sends seconds, not milliseconds). */
    timestamp?: number;
    /** Feed type / data quality indicator. */
    fyToken?: string;
    /** Exchange code: 10=NSE_CM, 11=NSE_FO, 12=BSE_CM, etc. */
    exch_feed_time?: number;
    /** Open price of the session. */
    open_price?: number;
    /** High price of the session. */
    high_price?: number;
    /** Low price of the session. */
    low_price?: number;
    /** Close / previous day close price. */
    prev_close_price?: number;
    /** Total buy quantity at best bid. */
    bid_qty?: number;
    /** Total sell quantity at best ask. */
    ask_qty?: number;
    /** Fallback: error code when Fyers emits an auth or protocol error inline as a tick. */
    code?: number;
    /** Fallback: error message string. */
    message?: string;
    /** Fallback: status string ('ok' or 'error'). */
    s?: string;
  }

  /**
   * Error payload emitted on the "error" event.
   *
   * Fyers uses numeric error codes. Code 1 indicates auth failure
   * (token expired or rejected). Other non-zero codes are transient
   * protocol or network errors.
   */
  interface FyersSocketError {
    /** Numeric error code. 1 = auth failure. */
    code?: number;
    /** Human-readable error description. */
    message?: string;
    /** Status string, typically 'error'. */
    s?: string;
  }

  /**
   * The fyersDataSocket factory — call getInstance() to get a socket instance.
   * Never call new fyersDataSocket() directly.
   *
   * getInstance() signature matches the SDK's actual calling convention:
   *   - fyersCombinedToken: "APPID:AccessToken" format
   *   - logPath: directory path for SDK-internal log files (pass '' to suppress)
   *   - enableLogging: whether the SDK writes its own log files
   *
   * The class form below is also exported for compatibility with import styles
   * from the payment branch that reference fyersDataSocket as a class.
   */
  interface FyersDataSocketFactory {
    getInstance(
      fyersCombinedToken: string,
      logPath?: string,
      enableLogging?: boolean,
    ): FyersDataSocketInstance;
  }

  /**
   * Class-style declaration for compatibility with the payment branch's import
   * convention (import { fyersDataSocket } then `new fyersDataSocket(...)`).
   * The real SDK uses getInstance(), but this shape allows TypeScript to accept
   * both usage patterns without errors.
   */
  class fyersDataSocket {
    constructor(config: { access_token: string; client_id: string });
    on(event: string, callback: (data: unknown) => void): void;
    subscribe(symbols: string[]): void;
    unsubscribe(symbols: string[]): void;
    connect(): void;
    close(): void;

    // Factory method also accessible on the class (matches real SDK shape)
    static getInstance(
      fyersCombinedToken: string,
      logPath?: string,
      enableLogging?: boolean,
    ): FyersDataSocketInstance;
  }

  /** fyersModel: REST API client (not used in this codebase — declared for completeness). */
  // biome-ignore lint/suspicious/noExplicitAny: Untyped Fyers SDK export — no better type available
  const fyersModel: any;

  /** fyersOrderSocket: Order update WebSocket (not used in this codebase). */
  // biome-ignore lint/suspicious/noExplicitAny: Untyped Fyers SDK export — no better type available
  const fyersOrderSocket: any;

  /** fyersTbtSocket: Tick-by-tick WebSocket (not used in this codebase). */
  // biome-ignore lint/suspicious/noExplicitAny: Untyped Fyers SDK export — no better type available
  const fyersTbtSocket: any;
}
