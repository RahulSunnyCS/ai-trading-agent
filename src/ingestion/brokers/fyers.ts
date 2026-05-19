// Bun-compat spike: fyers-api-v3 SDK is CommonJS. Tested with bun run --bun. If ESM import fails at runtime, use createRequire from 'module' as fallback.

/**
 * Fyers WebSocket Market-Data Adapter
 *
 * Implements the BrokerFeed interface for the Fyers data socket.
 * This adapter handles two distinct failure modes with different recovery strategies:
 *
 *   1. AUTH_FAILURE (Fyers error code 1): the access token is expired or invalid.
 *      No amount of retrying will fix this — it requires a new token. The adapter
 *      stops, emits a "disconnect" event with AUTH_FAILURE reason, and logs clearly.
 *
 *   2. TRANSIENT disconnect: network blip or broker-side issue. The adapter retries
 *      with exponential backoff (2s → 4s → 8s … max 64s) and indefinitely — index
 *      data is mission-critical during market hours.
 *
 * Security: accessToken and appId are never logged in full — only the first 4
 * characters followed by '...' are included in any log output.
 */

// Defensive CommonJS import for Bun compatibility.
// The fyers-api-v3 package ships as CommonJS (module.exports). In a Bun ESM
// project the named exports resolve correctly via `import * as`. The cast to
// `any` is intentional: at runtime in Bun the module object may have a `.default`
// property wrapping the real exports, OR the exports may be directly at the top
// level. We use a runtime coalesce so either layout works without TypeScript
// fighting us on the type (which correctly has no .default — that's the point).
import * as fyersMod from "fyers-api-v3";
import type { FyersDataSocketFactory } from "fyers-api-v3";

// Safely extract fyersDataSocket regardless of whether Bun wraps it in .default.
// The `as any` on fyersMod is required because TypeScript's type for fyersMod
// does not include a .default property (correctly so at type-check time), but
// at Bun runtime the CJS→ESM bridge may place the module.exports object there.
// biome-ignore lint/suspicious/noExplicitAny: CJS→ESM bridge coalesce — .default may or may not exist at Bun runtime
const modAny = fyersMod as any;
const fyersDataSocket: FyersDataSocketFactory = (modAny.default?.fyersDataSocket ??
  modAny.fyersDataSocket) as FyersDataSocketFactory;

import { EventEmitter } from "node:events";
import type { FyersDataSocketInstance, FyersSocketError, FyersTick } from "fyers-api-v3";
import type { Clock } from "../../utils/clock.js";
import type { BrokerFeed, BrokerTick } from "./types.js";
import { DisconnectReason } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Default symbols to subscribe to on every start().
 * NIFTY50-INDEX is the NIFTY spot price (used for ATM calculation).
 * INDIAVIX-INDEX is the India VIX (used for probability weighting).
 * Both are read-only subscription symbols — no order placement involved.
 */
const DEFAULT_SYMBOLS = ["NSE:NIFTY50-INDEX", "NSE:INDIAVIX-INDEX"] as const;

/**
 * Backoff configuration for transient reconnect retries.
 * Initial delay: 2 000 ms. Each retry doubles it up to MAX_BACKOFF_MS.
 * A ±20% random jitter is applied to avoid thundering-herd if multiple
 * instances restart simultaneously.
 */
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 64_000;
const JITTER_FRACTION = 0.2; // ±20%

// ─── Config ──────────────────────────────────────────────────────────────────

export interface FyersBrokerConfig {
  appId: string;
  accessToken: string;
  clock: Clock;
}

// ─── FyersBroker ─────────────────────────────────────────────────────────────

/**
 * Fyers market-data adapter implementing the BrokerFeed interface.
 *
 * Usage:
 *   const broker = new FyersBroker({ appId, accessToken, clock });
 *   broker.on('tick', handleTick);
 *   broker.on('disconnect', handleDisconnect);
 *   await broker.connect();
 *   await broker.subscribe(['NSE:NIFTY50-INDEX']);
 */
export class FyersBroker extends EventEmitter implements BrokerFeed {
  private readonly _appId: string;
  private readonly _accessToken: string;
  private readonly _clock: Clock;

  /** The active Fyers socket instance. Null before connect() or after stop(). */
  private _socket: FyersDataSocketInstance | null = null;

  /** Symbols currently requested for subscription. Stored so reconnects re-subscribe. */
  private _subscribedSymbols: string[] = [];

  /** Whether we are intentionally stopped (manual disconnect). Prevents reconnect. */
  private _stopped = false;

  /** Whether a reconnect is already scheduled/in-progress. Prevents double-schedules. */
  private _reconnecting = false;

  /**
   * Current backoff delay in milliseconds. Starts at INITIAL_BACKOFF_MS and
   * doubles on each retry up to MAX_BACKOFF_MS. Reset to initial on successful
   * connect.
   */
  private _backoffMs = INITIAL_BACKOFF_MS;

  /** Reference to the pending reconnect timer so stop() can cancel it. */
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Count of consecutive transient reconnect attempts. For logging purposes. */
  private _reconnectAttempt = 0;

  constructor(config: FyersBrokerConfig) {
    super();

    // Validate inputs eagerly — fail fast on obvious misconfiguration.
    if (!config.appId || config.appId.trim() === "") {
      throw new Error("FyersBroker: appId is required");
    }
    if (!config.accessToken || config.accessToken.trim() === "") {
      throw new Error("FyersBroker: accessToken is required");
    }

    this._appId = config.appId;
    this._accessToken = config.accessToken;
    this._clock = config.clock;
  }

  // ─── BrokerFeed public API ──────────────────────────────────────────────

  /**
   * Open the Fyers data socket connection.
   *
   * Resolves after the socket is created and connect() is called on it.
   * The actual "connected" state is confirmed asynchronously via the "connect"
   * event — callers should listen for that before sending orders/queries.
   */
  async connect(): Promise<void> {
    this._stopped = false;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._backoffMs = INITIAL_BACKOFF_MS;
    this._openSocket();
  }

  /**
   * Subscribe to market data for the given symbols.
   *
   * Can be called before or after connect(). Symbols are stored so that
   * reconnects automatically re-subscribe. Deduplicated before storage.
   */
  async subscribe(symbols: string[]): Promise<void> {
    // Merge new symbols into the running subscription list (deduplicated).
    const existing = new Set(this._subscribedSymbols);
    for (const sym of symbols) {
      existing.add(sym);
    }
    this._subscribedSymbols = Array.from(existing);

    if (this._socket) {
      this._socket.subscribe(this._subscribedSymbols);
    }
    // If socket is not yet open, symbols will be subscribed in the "connect" handler.
  }

  /**
   * Gracefully disconnect.
   *
   * Sets the stopped flag so no reconnect is attempted after the socket closes.
   */
  async disconnect(): Promise<void> {
    this._stopped = true;
    this._teardownSocket();

    // Cancel any pending reconnect timer.
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this.emit("disconnect", DisconnectReason.MANUAL);
  }

  // ─── EventEmitter overloads (BrokerFeed interface) ─────────────────────

  /**
   * Type-safe event registration matching the BrokerFeed interface.
   * We re-declare on() here with the same overloads so TypeScript narrows the
   * handler type at each call site.
   *
   * The `override` modifier is required because EventEmitter declares on() in
   * the base class. The implementation signature uses `(...args: unknown[])` to
   * satisfy TypeScript's overload-compatibility check: each overload signature
   * must be assignable to the implementation signature.
   */
  override on(event: "tick", handler: (tick: BrokerTick) => void): this;
  override on(event: "error", handler: (err: Error) => void): this;
  override on(event: "disconnect", handler: (reason: string) => void): this;
  override on(event: "reconnecting", handler: (attempt: number) => void): this;
  override on(event: string, handler: (...args: unknown[]) => void): this;
  // biome-ignore lint/suspicious/noExplicitAny: EventEmitter base signature requires any[] — using unknown[] on overrides but impl must match base
  override on(event: string, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  // ─── Internal socket lifecycle ──────────────────────────────────────────

  /**
   * Creates a new Fyers socket instance and wires up all event handlers.
   *
   * The Fyers SDK takes a combined "APPID:AccessToken" token string rather than
   * separate appId and accessToken parameters. We construct this here.
   *
   * We pass '' for logPath and false for enableLogging to suppress the SDK's
   * own file-based logging — we handle all logging ourselves for consistent
   * log format and token redaction.
   */
  private _openSocket(): void {
    // Construct the combined token in Fyers format: "APPID:AccessToken"
    const combinedToken = `${this._appId}:${this._accessToken}`;

    // Log with only the first 4 chars of each credential. Never log the full token.
    const maskedAppId = `${this._appId.slice(0, 4)}...`;
    const maskedToken = `${this._accessToken.slice(0, 4)}...`;
    console.log(`[FyersBroker] Opening socket — appId=${maskedAppId} token=${maskedToken}`);

    // We disable SDK auto-reconnect entirely (autoreconnect(false)) because we
    // implement our own exponential-backoff reconnection loop. Letting the SDK
    // also reconnect would cause duplicate subscriptions and unpredictable state.
    const socket = fyersDataSocket.getInstance(
      combinedToken,
      "", // no SDK log files
      false, // SDK logging disabled
    );

    // Disable the SDK's built-in reconnect — we handle this ourselves.
    socket.autoreconnect(false);

    this._socket = socket;

    // Wire up all event handlers before calling connect() so no events are missed.
    socket.on("connect", () => this._handleConnect());
    socket.on("message", (tick: FyersTick) => this._handleTick(tick));
    socket.on("error", (err: FyersSocketError) => this._handleError(err));
    socket.on("close", () => this._handleClose());

    socket.connect();
  }

  /**
   * Removes event handlers from the current socket and calls close().
   *
   * We do NOT call removeAllListeners() on our own EventEmitter here because
   * consumers may have registered handlers that should survive across reconnects.
   * Only the Fyers SDK socket's own listeners need cleanup.
   */
  private _teardownSocket(): void {
    if (this._socket) {
      try {
        this._socket.close();
      } catch {
        // close() can throw if the socket is already in a closed state.
        // Swallow — we are cleaning up anyway.
      }
      this._socket = null;
    }
  }

  // ─── Fyers event handlers ───────────────────────────────────────────────

  /**
   * Called when the Fyers socket successfully connects.
   *
   * Resets the backoff/retry counters and immediately re-subscribes to any
   * symbols that were registered (including those from before this connection
   * attempt, so reconnects are transparent to callers).
   */
  private _handleConnect(): void {
    console.log("[FyersBroker] Socket connected — subscribing to symbols");

    // Reset backoff on successful connection.
    this._backoffMs = INITIAL_BACKOFF_MS;
    this._reconnectAttempt = 0;
    this._reconnecting = false;

    // Always subscribe to the default index symbols first, then any additionally
    // requested symbols. Merge to avoid duplicates.
    const toSubscribe = Array.from(new Set([...DEFAULT_SYMBOLS, ...this._subscribedSymbols]));
    this._subscribedSymbols = toSubscribe;

    if (this._socket) {
      this._socket.subscribe(toSubscribe);
    }
  }

  /**
   * Called for every incoming tick from the Fyers data socket.
   *
   * Normalises the Fyers tick shape to the BrokerTick interface and emits it.
   *
   * The `underlying` field is derived by stripping the exchange prefix and the
   * index suffix from the symbol. E.g. 'NSE:NIFTY50-INDEX' → 'NIFTY'.
   * This heuristic covers the two default symbols; option tick symbols use a
   * different format parsed elsewhere (straddle-calc).
   */
  private _handleTick(tick: FyersTick): void {
    // Validate that the tick carries the minimum required fields.
    // Malformed ticks (missing ltp or symbol) are silently dropped — they
    // cannot be usefully forwarded and there is no corrective action to take.
    if (!tick.symbol || tick.ltp === undefined || tick.ltp === null) {
      return;
    }

    const brokerTick: BrokerTick = {
      symbol: tick.symbol,
      underlying: this._deriveUnderlying(tick.symbol),
      ltp: tick.ltp,
      // Use the clock for timestamp so tests can inject a deterministic clock.
      // Fyers sends epoch seconds in tick.timestamp; we use the clock's now()
      // (epoch ms) instead for consistency with the rest of the pipeline.
      time: this._clock.now(),
      volume: tick.vol_traded_today ?? tick.v ?? 0,
      oi: tick.oi ?? 0,
      bid: tick.bid_price ?? 0,
      ask: tick.ask_price ?? 0,
      // Index spot ticks have no optionType/strike/expiry — those remain undefined.
      isIndex: this._isIndexSymbol(tick.symbol),
    };

    this.emit("tick", brokerTick);
  }

  /**
   * Called when the Fyers socket emits an error.
   *
   * Distinguishes between:
   *   - Auth failure (code === 1): token is expired/invalid. Stop and do not retry.
   *   - Anything else: treat as transient, schedule a reconnect.
   */
  private _handleError(err: FyersSocketError): void {
    const code = err.code;
    const message = err.message ?? "unknown error";

    if (code === 1) {
      // Auth failure — the token is expired or invalid. Retrying is pointless.
      // Log clearly so the operator knows exactly what to do.
      console.error(
        `[FyersBroker] Fyers auth failure — regenerate access token. token prefix=${this._accessToken.slice(0, 4)}...`,
      );

      this._teardownSocket();
      this.emit("disconnect", DisconnectReason.AUTH_FAILURE);
      // Do not schedule a reconnect.
      return;
    }

    // For all other error codes, treat as transient. Log and let the "close"
    // event trigger the reconnect (Fyers closes the socket after an error).
    console.warn(`[FyersBroker] Socket error (code=${code}): ${message} — will attempt reconnect`);
    this.emit("error", new Error(`Fyers socket error code=${code}: ${message}`));
  }

  /**
   * Called when the Fyers socket closes.
   *
   * If we are stopped (manual disconnect or auth failure), do nothing.
   * Otherwise, treat as a transient disconnect and schedule a reconnect.
   */
  private _handleClose(): void {
    if (this._stopped) {
      // Intentional close — no reconnect.
      return;
    }

    if (this._reconnecting) {
      // A reconnect is already in progress or scheduled — don't double-schedule.
      return;
    }

    console.warn("[FyersBroker] Socket closed unexpectedly — scheduling reconnect");
    this._teardownSocket();
    this.emit("disconnect", DisconnectReason.TRANSIENT);
    this._scheduleReconnect();
  }

  // ─── Exponential backoff reconnect ─────────────────────────────────────

  /**
   * Schedules the next reconnect attempt with jittered exponential backoff.
   *
   * We use setTimeout here (not the Clock abstraction) because:
   *   1. The Clock abstraction is tick-driven and not designed for scheduling
   *      one-shot async delays of multiple seconds.
   *   2. Reconnect logic must fire against wall-clock time regardless of
   *      whether simulation mode is active — a stopped socket needs real time.
   *   3. The timer reference is stored in _reconnectTimer so stop() can
   *      cancel it cleanly.
   *
   * Maximum retry attempts is Infinity — index data is critical during market
   * hours and we never give up on transient failures.
   */
  private _scheduleReconnect(): void {
    this._reconnecting = true;
    this._reconnectAttempt += 1;

    // Apply ±JITTER_FRACTION random jitter to prevent thundering-herd if
    // multiple instances restart simultaneously.
    const jitter = 1 + (Math.random() * 2 - 1) * JITTER_FRACTION;
    const delay = Math.round(this._backoffMs * jitter);

    console.log(
      `[FyersBroker] Reconnect attempt ${this._reconnectAttempt} in ${delay}ms ` +
        `(base backoff=${this._backoffMs}ms)`,
    );

    this.emit("reconnecting", this._reconnectAttempt);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;

      if (this._stopped) {
        // Stop was called while waiting — abort.
        this._reconnecting = false;
        return;
      }

      // Double the backoff for the next attempt, capped at MAX_BACKOFF_MS.
      this._backoffMs = Math.min(this._backoffMs * 2, MAX_BACKOFF_MS);

      this._openSocket();
    }, delay);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Derives the underlying instrument name from a Fyers symbol string.
   *
   * Handles the two default index symbols explicitly:
   *   'NSE:NIFTY50-INDEX'   → 'NIFTY'
   *   'NSE:INDIAVIX-INDEX'  → 'INDIAVIX'
   *
   * For option symbols (e.g. 'NSE:NIFTY25O1623000CE'), returns the underlying
   * portion by stripping the exchange prefix and taking the alphabetic prefix
   * of the instrument name. This is a best-effort heuristic — the straddle-calc
   * module does full symbol parsing for option ticks.
   */
  private _deriveUnderlying(symbol: string): string {
    // Strip the exchange prefix (e.g. 'NSE:' or 'BSE:').
    const withoutExchange = symbol.includes(":") ? (symbol.split(":")[1] ?? symbol) : symbol;

    // For index symbols ending in '-INDEX', extract the meaningful part.
    if (withoutExchange.endsWith("-INDEX")) {
      const name = withoutExchange.replace("-INDEX", "");
      // Map known index variants to their canonical underlying name.
      if (name === "NIFTY50") return "NIFTY";
      if (name === "INDIAVIX") return "INDIAVIX";
      return name;
    }

    // For option symbols, the underlying is the leading alphabetic segment.
    // E.g. 'NIFTY25O1623000CE' → 'NIFTY', 'BANKNIFTY25O1623000CE' → 'BANKNIFTY'.
    const match = withoutExchange.match(/^([A-Z]+)/);
    return match ? (match[1] ?? withoutExchange) : withoutExchange;
  }

  /**
   * Returns true if the symbol is an index-spot or VIX tick (no option fields).
   */
  private _isIndexSymbol(symbol: string): boolean {
    return symbol.includes("-INDEX");
  }
}
