// Fyers Data WebSocket v3 adapter
//
// Why Fyers over Angel One for this system:
//   1. String-based option symbols (NSE:NIFTY255824000CE) — no scripmaster lookup.
//      Every Thursday new weekly contracts are listed; Fyers needs zero extra work,
//      Angel One requires re-downloading and parsing a large JSON to get new token IDs.
//   2. Dynamic ATM re-subscription is one symbol-string construction, not a token lookup.
//   3. VIX subscribed directly as NSE:INDIAVIX-INDEX tick — no extra auth or API call.
//   4. Single stable token (appId:accessToken). Angel One jwtToken expires daily and
//      requires automated daily refresh — an entire auth pipeline just to stay connected.

import { fyersDataSocket } from 'fyers-api-v3';
import type { BrokerFeed, BrokerTick, Instrument } from './types';
import { buildFyersSymbol, FYERS_INDEX_SYMBOLS, parseFyersSymbol } from './instrument-registry';

// Raw tick shape coming from the Fyers fyersDataSocket message event.
// Fyers FullMode returns prices directly in INR (no paise conversion needed).
interface FyersTick {
  symbol:     string;
  ltp?:       number;
  bid_price?: number;
  ask_price?: number;
  vol_traded_today?: number;
  oi?:        number;
  tt?:        number;   // last trade timestamp (unix seconds)
  // LiteMode fields (subset)
  v?: {
    lp?: number;        // lite mode last price
    bp?: number;        // bid price (lite)
    sp?: number;        // ask/sell price (lite)
    v?:  number;        // volume
    oi?: number;
  };
}

export interface FyersConfig {
  appId:       string;   // your Fyers App ID (client_id)
  accessToken: string;   // OAuth access token — format: "{appId}:{token}" OR plain token
                         // fyersDataSocket.getInstance expects "{appId}:{accessToken}"
  logPath?:    string;   // directory for Fyers SDK logs (default: /tmp/fyers-logs)
  enableLogs?: boolean;
}

export class FyersFeed implements BrokerFeed {
  private skt: ReturnType<typeof fyersDataSocket.getInstance> | null = null;
  private readonly cfg: FyersConfig;
  private tickHandlers:       Array<(t: BrokerTick) => void> = [];
  private connectHandlers:    Array<() => void>               = [];
  private disconnectHandlers: Array<(r: string) => void>      = [];
  private errorHandlers:      Array<(e: Error) => void>       = [];
  // Track currently subscribed Fyers symbols so we can diff on re-subscribe
  private subscribedSymbols = new Set<string>();

  constructor(cfg: FyersConfig) {
    this.cfg = cfg;
  }

  async connect(): Promise<void> {
    // Fyers expects "{appId}:{accessToken}" as the getInstance argument
    const token = this.cfg.accessToken.includes(':')
      ? this.cfg.accessToken
      : `${this.cfg.appId}:${this.cfg.accessToken}`;

    this.skt = fyersDataSocket.getInstance(
      token,
      this.cfg.logPath  ?? '/tmp/fyers-logs',
      this.cfg.enableLogs ?? false
    );

    this.skt.on('connect', () => {
      console.log('[fyers] WebSocket connected');
      // Request FullMode on channel 1 for full tick data (ltp, bid, ask, volume, oi)
      this.skt!.mode(this.skt!.FullMode, 1);
      for (const h of this.connectHandlers) h();
    });

    this.skt.on('message', (...args: unknown[]) => {
      const raw   = args[0] as FyersTick | FyersTick[];
      const ticks = Array.isArray(raw) ? raw : [raw];
      for (const t of ticks) this.handleTick(t);
    });

    this.skt.on('error', (msg: unknown) => {
      const err = msg instanceof Error ? msg : new Error(String(msg));
      console.error('[fyers] Error:', err.message);
      for (const h of this.errorHandlers) h(err);
    });

    this.skt.on('close', () => {
      console.warn('[fyers] WebSocket closed');
      for (const h of this.disconnectHandlers) h('closed');
    });

    // Built-in exponential back-off reconnect (max 20 retries, 5s initial delay)
    this.skt.autoreconnect(20, 5);
    this.skt.connect();
  }

  disconnect(): void {
    this.skt?.close?.();
    this.skt = null;
  }

  subscribe(instruments: Instrument[]): void {
    if (!this.skt) return;

    const newSymbols = instruments.map((i) => buildFyersSymbol(i));
    const toAdd      = newSymbols.filter((s) => !this.subscribedSymbols.has(s));
    if (toAdd.length === 0) return;

    this.skt.subscribe(toAdd, false, 1);
    for (const s of toAdd) this.subscribedSymbols.add(s);
    console.log(`[fyers] Subscribed: ${toAdd.join(', ')}`);
  }

  unsubscribe(instruments: Instrument[]): void {
    if (!this.skt) return;

    const symbols  = instruments.map((i) => buildFyersSymbol(i));
    const toRemove = symbols.filter((s) => this.subscribedSymbols.has(s));
    if (toRemove.length === 0) return;

    this.skt.unsubscribe(toRemove, false, 1);
    for (const s of toRemove) this.subscribedSymbols.delete(s);
    console.log(`[fyers] Unsubscribed: ${toRemove.join(', ')}`);
  }

  // Subscribe to the spot index and VIX for a given underlying.
  // These are always needed regardless of which option strikes are active.
  subscribeIndexes(underlyings: Array<'NIFTY' | 'BANKNIFTY' | 'SENSEX'>): void {
    if (!this.skt) return;
    const symbols: string[] = [];
    for (const u of underlyings) {
      const s = FYERS_INDEX_SYMBOLS[u];
      if (s && !this.subscribedSymbols.has(s)) {
        symbols.push(s);
        this.subscribedSymbols.add(s);
      }
    }
    // VIX always needed for signal probability adjustments
    const vix = FYERS_INDEX_SYMBOLS.VIX;
    if (!this.subscribedSymbols.has(vix)) {
      symbols.push(vix);
      this.subscribedSymbols.add(vix);
    }
    if (symbols.length > 0) {
      this.skt.subscribe(symbols, false, 1);
      console.log(`[fyers] Subscribed indexes: ${symbols.join(', ')}`);
    }
  }

  onTick(h: (t: BrokerTick) => void):       void { this.tickHandlers.push(h); }
  onConnect(h: () => void):                  void { this.connectHandlers.push(h); }
  onDisconnect(h: (r: string) => void):      void { this.disconnectHandlers.push(h); }
  onError(h: (e: Error) => void):            void { this.errorHandlers.push(h); }

  private handleTick(raw: FyersTick): void {
    if (!raw.symbol) return;

    const ltp = raw.ltp ?? raw.v?.lp;
    if (ltp === undefined || ltp === null) return;

    const parsed     = parseFyersSymbol(raw.symbol);
    const tick: BrokerTick = {
      symbol:     raw.symbol,
      underlying: parsed?.underlying ?? 'NIFTY',
      expiry:     parsed?.expiry,
      strike:     parsed?.strike,
      optionType: parsed?.optionType,
      ltp,
      bid:        raw.bid_price ?? raw.v?.bp,
      ask:        raw.ask_price ?? raw.v?.sp,
      volume:     raw.vol_traded_today ?? raw.v?.v,
      oi:         raw.oi ?? raw.v?.oi,
      timestamp:  raw.tt ? new Date(raw.tt * 1000) : new Date(),
    };

    for (const h of this.tickHandlers) h(tick);
  }
}
