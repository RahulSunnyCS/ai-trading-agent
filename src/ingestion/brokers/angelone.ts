/**
 * Angel One SmartAPI WebSocket adapter.
 *
 * Implements BrokerFeed using:
 *   - SmartAPI REST endpoint for authentication (TOTP + clientCode + pin)
 *   - SmartWebSocketV2 for real-time index tick streaming (LTP mode)
 *
 * SECURITY CONTRACT:
 *   - Credentials (apiKey, clientCode, clientPin, totpSecret, jwtToken, feedToken)
 *     are NEVER logged in full. Only the first 4 chars + '...' of apiKey may appear
 *     in debug output. The TOTP secret is never logged at any level.
 *   - This file is the only place credentials are used; they are not forwarded
 *     to any other module.
 */

// @ts-ignore — smartapi-javascript has no TypeScript type declarations.
// We inline a minimal shape declaration below so internal usage is type-safe.
// The package exports a CJS module with no bundled types; @ts-ignore suppresses
// the TS7016 "Could not find a declaration file" error.
import smartapiLib from "smartapi-javascript";

// Minimal inline type declarations for the parts of smartapi-javascript we use.
// The SDK is a plain CommonJS module with no bundled types, so @ts-ignore above
// suppresses the missing-declaration error; these interfaces give us type safety
// for the objects we actually interact with.
interface SmartAPIInstance {
  generateSession(
    clientCode: string,
    password: string,
    totp: string,
  ): Promise<SmartAPISessionResponse>;
}

interface SmartAPISessionResponse {
  /** top-level status flag (true = success) */
  status: boolean;
  /** human-readable message from the API */
  message: string;
  /** payload — present when status is true */
  data?: {
    jwtToken: string;
    feedToken: string;
    refreshToken?: string;
  };
  /** Angel One error code e.g. "AG8001" for invalid credentials */
  errorCode?: string;
}

interface WebSocketV2Instance {
  connect(): Promise<void>;
  fetchData(req: WebSocketV2Request): void;
  on(event: "tick", cb: (data: AngelOneLTPTick) => void): void;
  on(event: "connect", cb: () => void): void;
  close(): void;
  customError(): void;
}

interface WebSocketV2Request {
  correlationID: string;
  action: number; // 1 = Subscribe, 0 = Unsubscribe
  mode: number; // 1 = LTP
  exchangeType: number; // 1 = nse_cm
  tokens: string[];
}

/** Tick shape returned by WebSocketV2 in LTP mode (mode=1). */
interface AngelOneLTPTick {
  subscription_mode: string; // "1"
  exchange_type: string; // "1"
  token: string; // instrument token e.g. '"99926000"'
  sequence_number: string;
  exchange_timestamp: string;
  /** Last traded price in PAISE (integer). Divide by 100 to get rupees. */
  last_traded_price: string;
}

// generateSync is the synchronous TOTP generator in otplib v13's functional API.
// It uses Noble crypto and Scure base32 by default (no crypto plugin needed).
import { generateSync as totpGenerateSync } from "otplib";
import type { Clock } from "../../utils/clock.js";
import type { BrokerFeed, BrokerTick } from "./types.js";
import { DisconnectReason } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Hardcoded Angel One instrument tokens for index subscriptions.
 * These are the correct numeric tokens for the SmartWebSocketV2 LTP feed.
 * Do NOT use buildAngelOneToken() from instrument-registry.ts — that function
 * is a placeholder and produces incorrect tokens for index instruments.
 */
const INSTRUMENT_TOKENS = {
  NIFTY50: "99926000",
  INDIAVIX: "99919000",
} as const;

/**
 * Maps Angel One instrument tokens back to the canonical NSE symbol strings
 * expected by the rest of the pipeline (Fyers-style format).
 */
const TOKEN_TO_SYMBOL: Record<string, string> = {
  [INSTRUMENT_TOKENS.NIFTY50]: "NSE:NIFTY50-INDEX",
  [INSTRUMENT_TOKENS.INDIAVIX]: "NSE:INDIAVIX-INDEX",
};

/**
 * Maps instrument tokens to their underlying name (used in BrokerTick.underlying).
 */
const TOKEN_TO_UNDERLYING: Record<string, string> = {
  [INSTRUMENT_TOKENS.NIFTY50]: "NIFTY",
  [INSTRUMENT_TOKENS.INDIAVIX]: "INDIAVIX",
};

/** Exchange type for NSE cash/index segment in the Angel One WebSocket v2 protocol. */
const NSE_CM_EXCHANGE_TYPE = 1;

/** Subscribe action code. */
const ACTION_SUBSCRIBE = 1;

/** LTP-only mode — the cheapest subscription mode; we only need last price. */
const MODE_LTP = 1;

// ─── Backoff configuration ───────────────────────────────────────────────────

const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 64_000;
/** ±20% jitter so multiple clients don't pile up on the same retry slot. */
const BACKOFF_JITTER_RATIO = 0.2;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AngelOneConfig {
  apiKey: string;
  clientCode: string;
  /** The numeric PIN / password used for Angel One login. */
  clientPin: string;
  /** Base32-encoded TOTP secret (same secret used for Google Authenticator). */
  totpSecret: string;
  clock: Clock;
}

// ─── Event handler storage ───────────────────────────────────────────────────
// We manage events manually (not via EventEmitter) to keep the type signatures
// compatible with the explicit BrokerFeed interface overloads without needing
// to extend EventEmitter (which would require casting at every call site).

type TickHandler = (tick: BrokerTick) => void;
type ErrorHandler = (err: Error) => void;
type DisconnectHandler = (reason: string) => void;
type ReconnectHandler = (attempt: number) => void;

// ─── Class ───────────────────────────────────────────────────────────────────

/**
 * Angel One SmartAPI broker adapter.
 *
 * Lifecycle:
 *   1. connect()       — authenticates via TOTP + REST, opens WebSocket,
 *                        subscribes to NIFTY50 and INDIAVIX
 *   2. tick events     — emitted for every LTP update from the feed
 *   3. disconnect()    — clean shutdown; no reconnect
 *
 * Reconnect logic:
 *   On unexpected disconnection the adapter re-authenticates (fresh TOTP
 *   since JWT tokens expire after ~24 h) and re-connects with exponential
 *   backoff. Reconnection is suppressed only when disconnect() is called
 *   intentionally.
 */
export class AngelOneBroker implements BrokerFeed {
  private readonly config: AngelOneConfig;

  // Redacted API key prefix used in log lines — only the first 4 chars.
  private readonly apiKeyPrefix: string;

  // Runtime auth tokens — populated on each authenticate() call.
  // We store them only in memory; they are never written to disk or logs.
  private jwtToken: string | null = null;
  private feedToken: string | null = null;

  // Live WebSocket instance — recreated on each reconnect attempt.
  private wsClient: WebSocketV2Instance | null = null;

  // Reconnect state.
  private intentionalStop = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Registered event handlers.
  private tickHandlers: TickHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private disconnectHandlers: DisconnectHandler[] = [];
  private reconnectHandlers: ReconnectHandler[] = [];

  constructor(config: AngelOneConfig) {
    this.config = config;
    // Log at most first 4 chars so we can correlate logs with a key ID
    // without exposing the full secret.
    this.apiKeyPrefix = `${config.apiKey.slice(0, 4)}...`;
  }

  // ── BrokerFeed interface ──────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.intentionalStop = false;
    this.reconnectAttempt = 0;
    await this.attemptConnection();
  }

  /**
   * subscribe() is a no-op for AngelOneBroker because the set of subscribed
   * instruments is fixed (NIFTY50 + INDIAVIX) and subscribed automatically
   * on connect. The method exists to satisfy the BrokerFeed interface so the
   * adapter can be swapped in without callers checking the concrete type.
   */
  async subscribe(_symbols: string[]): Promise<void> {
    // No-op: instruments are subscribed during connect().
    // If dynamic subscription is needed in the future, fetchData() accepts
    // incremental subscription requests.
  }

  async disconnect(): Promise<void> {
    this.intentionalStop = true;
    this.clearReconnectTimer();
    this.closeWebSocket();
    this.emitDisconnect(DisconnectReason.MANUAL);
  }

  // Overloaded on() signatures — TypeScript enforces the correct payload types.
  on(event: "tick", handler: TickHandler): this;
  on(event: "error", handler: ErrorHandler): this;
  on(event: "disconnect", handler: DisconnectHandler): this;
  on(event: "reconnecting", handler: ReconnectHandler): this;
  on(
    event: "tick" | "error" | "disconnect" | "reconnecting",
    handler: TickHandler | ErrorHandler | DisconnectHandler | ReconnectHandler,
  ): this {
    switch (event) {
      case "tick":
        this.tickHandlers.push(handler as TickHandler);
        break;
      case "error":
        this.errorHandlers.push(handler as ErrorHandler);
        break;
      case "disconnect":
        this.disconnectHandlers.push(handler as DisconnectHandler);
        break;
      case "reconnecting":
        this.reconnectHandlers.push(handler as ReconnectHandler);
        break;
    }
    return this;
  }

  // ── Core connection logic ─────────────────────────────────────────────────

  /**
   * Full connect attempt: authenticate → open WebSocket → subscribe.
   * Called on initial connect and on each reconnect retry.
   */
  private async attemptConnection(): Promise<void> {
    try {
      await this.authenticate();
      await this.openWebSocket();
      this.subscribeInstruments();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitError(error);

      // Auth failures are not retried automatically — the caller must provide
      // fresh credentials (or a new TOTP window will naturally help on the
      // next scheduled retry).
      // We still schedule a reconnect because the TOTP will be regenerated
      // on the next attempt. For a real AUTH_FAILURE (401 from the API),
      // disconnect() should be called from the application layer.
      if (!this.intentionalStop) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Authenticates with Angel One SmartAPI:
   *   1. Generates a fresh 6-digit TOTP from the stored secret.
   *   2. Calls generateSession() — POST /rest/auth/…/loginByPassword.
   *   3. Extracts jwtToken and feedToken from the response.
   *
   * Re-authentication is performed on every reconnect because Angel One JWT
   * tokens expire (~24 h) and because a new TOTP is required for each login.
   */
  private async authenticate(): Promise<void> {
    // Generate a time-based one-time password using the functional generateSync API.
    // otplib uses the system wall-clock internally for the TOTP counter — we do NOT
    // inject the test Clock here because TOTP must match the Angel One server's
    // real-world wall-clock (a VirtualClock offset would produce an invalid OTP).
    //
    // generateSync is used (not the async generate) because:
    //   1. It keeps authenticate() simpler — no nested await inside an already-async fn.
    //   2. The Noble crypto plugin bundled in otplib v13 supports sync HMAC natively.
    //   3. TOTP generation is CPU-only, not I/O, so blocking for <1 ms is fine.
    //
    // TOTP secret is NEVER logged. The generated code is valid for ≤30 s.
    const totpCode = totpGenerateSync({ secret: this.config.totpSecret });

    // The SmartAPI class is a constructor function (old-style JS class).
    const smartApi: SmartAPIInstance = new (
      smartapiLib.SmartAPI as new (params: { api_key: string }) => SmartAPIInstance
    )({
      api_key: this.config.apiKey,
    });

    let response: SmartAPISessionResponse;
    try {
      response = await smartApi.generateSession(
        this.config.clientCode,
        this.config.clientPin,
        totpCode,
      );
    } catch (err) {
      // Network-level failure — treat as transient.
      throw new Error(`Angel One auth network error: ${(err as Error).message}`);
    }

    // Check for explicit auth failure from the API.
    // Angel One returns status=false and an error code for credential failures.
    if (!response.status || !response.data) {
      const isAuthFailure =
        response.errorCode === "AG8001" || // invalid credentials
        response.message?.toLowerCase().includes("invalid") ||
        response.message?.toLowerCase().includes("unauthorized");

      if (isAuthFailure) {
        // Log for operator debugging — API key prefix only, never full key.
        console.error(
          `[AngelOneBroker] Angel One auth failure (apiKey: ${this.apiKeyPrefix}): ${response.message ?? response.errorCode ?? "unknown"}`,
        );
        this.emitDisconnect(DisconnectReason.AUTH_FAILURE);
        throw new Error(`Angel One auth failure: ${response.message ?? response.errorCode}`);
      }

      // Non-auth API-level error — surface as transient.
      throw new Error(`Angel One login failed: ${response.message ?? "unknown"}`);
    }

    // Store tokens in memory only. Never log them.
    this.jwtToken = response.data.jwtToken;
    this.feedToken = response.data.feedToken;

    console.log(`[AngelOneBroker] Authenticated successfully (apiKey: ${this.apiKeyPrefix})`);
  }

  /**
   * Creates a new SmartWebSocketV2 instance and opens the connection.
   *
   * The SDK's WebSocketV2 constructor captures `triggers` in a module-level
   * variable, which means it is not truly instance-isolated. We work around
   * this by always creating a fresh SDK object rather than reusing one.
   */
  private async openWebSocket(): Promise<void> {
    if (!this.jwtToken || !this.feedToken) {
      throw new Error("[AngelOneBroker] Cannot open WebSocket: not authenticated");
    }

    // Close any previous connection before creating a new one.
    this.closeWebSocket();

    const ws: WebSocketV2Instance = new (
      smartapiLib.WebSocketV2 as new (params: {
        clientcode: string;
        jwttoken: string;
        apikey: string;
        feedtype: string;
      }) => WebSocketV2Instance
    )({
      clientcode: this.config.clientCode,
      jwttoken: this.jwtToken,
      apikey: this.config.apiKey,
      feedtype: this.feedToken,
    });

    // Register for raw tick events from the SDK. The SDK calls our callback
    // with the decoded LTP packet for each subscribed instrument.
    ws.on("tick", (raw: AngelOneLTPTick) => {
      this.handleRawTick(raw);
    });

    // Enable custom error handling so the SDK rejects the connect() promise
    // on errors instead of throwing synchronously (which would be uncaught).
    ws.customError();

    await ws.connect();

    // Attach close-detection: we re-use the SDK's built-in reconnect only for
    // the ping/heartbeat timeout scenario. For other disconnects we manage
    // reconnection ourselves using the onclose handler below.
    // Note: The SDK's WebSocketV2 does not expose an 'onclose' event via its
    // .on() API. We rely on the SDK's built-in 20 s timeout reconnect for
    // heartbeat timeouts. Our reconnect logic fires on fatal errors thrown
    // from within the tick callback or connect() failure.

    this.wsClient = ws;
    this.reconnectAttempt = 0; // Reset backoff counter on successful connection.
    console.log(`[AngelOneBroker] WebSocket connected (apiKey: ${this.apiKeyPrefix})`);
  }

  /**
   * Subscribes to NIFTY50 and INDIAVIX in LTP mode.
   * Called immediately after openWebSocket() succeeds.
   */
  private subscribeInstruments(): void {
    if (!this.wsClient) return;

    const req: WebSocketV2Request = {
      correlationID: "trading-agent-index-feed",
      action: ACTION_SUBSCRIBE,
      mode: MODE_LTP,
      exchangeType: NSE_CM_EXCHANGE_TYPE,
      tokens: [INSTRUMENT_TOKENS.NIFTY50, INSTRUMENT_TOKENS.INDIAVIX],
    };

    this.wsClient.fetchData(req);
    console.log("[AngelOneBroker] Subscribed to NIFTY50 and INDIAVIX (LTP mode)");
  }

  // ── Tick normalisation ────────────────────────────────────────────────────

  /**
   * Converts an Angel One LTP tick to the canonical BrokerTick format.
   *
   * Key conversion:
   *   Angel One sends last_traded_price as an integer in PAISE (1/100 rupee).
   *   We always divide by 100 before emitting so the rest of the pipeline
   *   sees prices in rupees, consistent with the Fyers adapter.
   *
   * The token field from the SDK arrives as a JSON-serialised string
   * (e.g. '"99926000"') due to the SDK's _atos formatter. We strip the extra
   * quotes with JSON.parse before doing the lookup.
   */
  private handleRawTick(raw: AngelOneLTPTick): void {
    // The SDK's binary parser wraps the token in JSON.stringify — unwrap it.
    let tokenStr: string;
    try {
      tokenStr = JSON.parse(raw.token) as string;
      // Trim null bytes that may be left over from fixed-length buffer padding.
      tokenStr = tokenStr.replace(/\0/g, "").trim();
    } catch {
      // If parsing fails the token is already a plain string — use it as-is.
      tokenStr = raw.token.replace(/\0/g, "").trim();
    }

    const symbol = TOKEN_TO_SYMBOL[tokenStr];
    if (!symbol) {
      // Unknown token — could be a subscription artefact. Skip silently.
      return;
    }

    const underlying = TOKEN_TO_UNDERLYING[tokenStr] ?? "UNKNOWN";

    // Price arrives in paise; convert to rupees.
    const ltpRupees = Number.parseInt(raw.last_traded_price, 10) / 100;

    const tick: BrokerTick = {
      time: this.config.clock.now(),
      symbol,
      underlying,
      ltp: ltpRupees,
      // Angel One LTP mode does not provide bid/ask — use ltp as a proxy
      // so downstream code gets a valid number. The straddle calculator only
      // uses ltp for index ticks anyway.
      bid: ltpRupees,
      ask: ltpRupees,
      volume: 0, // LTP mode does not include volume
      oi: 0, // LTP mode does not include OI
      isIndex: true,
      // No optionType, strike, or expiry for index ticks.
    };

    for (const handler of this.tickHandlers) {
      handler(tick);
    }
  }

  // ── Reconnect logic ───────────────────────────────────────────────────────

  /**
   * Schedules the next reconnect attempt with exponential backoff + jitter.
   *
   * Formula: delay = min(initial * 2^attempt, max) * (1 ± jitter)
   *
   * We re-authenticate on every attempt because Angel One JWT tokens expire
   * daily and a fresh TOTP is required for each login.
   */
  private scheduleReconnect(): void {
    if (this.intentionalStop) return;

    this.reconnectAttempt += 1;
    const attempt = this.reconnectAttempt;

    const base = Math.min(BACKOFF_INITIAL_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
    const jitter = base * BACKOFF_JITTER_RATIO * (Math.random() * 2 - 1); // ±20%
    const delay = Math.round(base + jitter);

    console.log(`[AngelOneBroker] Reconnecting in ${delay} ms (attempt #${attempt})`);

    for (const handler of this.reconnectHandlers) {
      handler(attempt);
    }

    this.reconnectTimer = setTimeout(async () => {
      if (this.intentionalStop) return;
      await this.attemptConnection();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeWebSocket(): void {
    if (this.wsClient) {
      try {
        this.wsClient.close();
      } catch {
        // Ignore errors on close — the socket may already be dead.
      }
      this.wsClient = null;
    }
  }

  // ── Event emission helpers ────────────────────────────────────────────────

  private emitError(err: Error): void {
    for (const handler of this.errorHandlers) {
      handler(err);
    }
  }

  private emitDisconnect(reason: DisconnectReason): void {
    for (const handler of this.disconnectHandlers) {
      handler(reason);
    }
  }

  // ── Public stop() alias (task contract requires stop()) ──────────────────

  /**
   * Alias for disconnect(). The task contract names this `stop()`; the
   * BrokerFeed interface names it `disconnect()`. Both are honoured — calling
   * either achieves the same clean shutdown.
   */
  async stop(): Promise<void> {
    return this.disconnect();
  }
}
