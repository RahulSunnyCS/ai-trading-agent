import WebSocket from 'ws';
import { query } from '../db/client';
import { streamPublish, STREAMS } from '../redis/client';
import type { MarketTick, Underlying, OptionType } from '../db/schema';

export interface NseWebSocketConfig {
  url: string;
  apiKey: string;
  accessToken: string;
  // Instruments to subscribe: token → symbol mapping
  instruments: Map<number, InstrumentInfo>;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
}

export interface InstrumentInfo {
  symbol: string;
  underlying: Underlying;
  expiry?: Date;
  strike?: number;
  optionType?: OptionType;
}

// Tick payload coming in from broker WebSocket
interface RawTick {
  instrument_token: number;
  last_price: number;
  bid?: number;
  ask?: number;
  volume?: number;
  oi?: number;
  timestamp?: string;
}

export class NseWebSocketFeed {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private readonly config: Required<NseWebSocketConfig>;

  constructor(config: NseWebSocketConfig) {
    this.config = {
      reconnectDelayMs: 3_000,
      maxReconnectAttempts: 20,
      ...config,
    };
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const { url, apiKey, accessToken } = this.config;

    console.log(`[nse-ws] Connecting to ${url}`);
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `token ${apiKey}:${accessToken}`,
      },
    });

    this.ws.on('open', () => {
      console.log('[nse-ws] Connected');
      this.reconnectAttempts = 0;
      this.subscribe();
    });

    this.ws.on('message', (data: Buffer) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code, reason) => {
      console.warn(`[nse-ws] Disconnected (${code}): ${reason}`);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[nse-ws] Error:', err.message);
    });
  }

  private subscribe(): void {
    const tokens = Array.from(this.config.instruments.keys());
    const msg = JSON.stringify({
      a: 'subscribe',
      v: tokens,
    });
    this.ws?.send(msg);
    console.log(`[nse-ws] Subscribed to ${tokens.length} instruments`);
  }

  private handleMessage(data: Buffer): void {
    // Broker WebSocket packets are binary — parse per broker protocol.
    // This implementation assumes a JSON-based feed (e.g., Quantiply / mock).
    // For Zerodha Kite, replace with binary packet parsing.
    let ticks: RawTick[];
    try {
      ticks = JSON.parse(data.toString());
      if (!Array.isArray(ticks)) ticks = [ticks];
    } catch {
      return; // ignore malformed packets
    }

    for (const tick of ticks) {
      const info = this.config.instruments.get(tick.instrument_token);
      if (!info) continue;

      const marketTick: MarketTick = {
        time:        new Date(tick.timestamp ?? Date.now()),
        symbol:      info.symbol,
        underlying:  info.underlying,
        expiry:      info.expiry,
        strike:      info.strike,
        option_type: info.optionType,
        ltp:         tick.last_price,
        bid:         tick.bid,
        ask:         tick.ask,
        volume:      tick.volume,
        oi:          tick.oi,
      };

      // Fire-and-forget: persist + publish in parallel
      this.persistTick(marketTick);
      this.publishTick(marketTick);
    }
  }

  private persistTick(tick: MarketTick): void {
    query(
      `INSERT INTO market_ticks
         (time, symbol, underlying, expiry, strike, option_type, ltp, bid, ask, volume, oi)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        tick.time, tick.symbol, tick.underlying, tick.expiry ?? null,
        tick.strike ?? null, tick.option_type ?? null,
        tick.ltp, tick.bid ?? null, tick.ask ?? null,
        tick.volume ?? null, tick.oi ?? null,
      ]
    ).catch((err) => console.error('[nse-ws] Persist error:', err.message));
  }

  private publishTick(tick: MarketTick): void {
    streamPublish(STREAMS.MARKET_TICKS, {
      symbol:      tick.symbol,
      underlying:  tick.underlying,
      ltp:         String(tick.ltp),
      bid:         String(tick.bid ?? ''),
      ask:         String(tick.ask ?? ''),
      volume:      String(tick.volume ?? ''),
      oi:          String(tick.oi ?? ''),
      strike:      String(tick.strike ?? ''),
      option_type: tick.option_type ?? '',
      expiry:      tick.expiry?.toISOString() ?? '',
      time:        tick.time.toISOString(),
    }).catch((err) => console.error('[nse-ws] Stream publish error:', err.message));
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('[nse-ws] Max reconnect attempts reached. Giving up.');
      return;
    }

    const delay = this.config.reconnectDelayMs * Math.min(2 ** this.reconnectAttempts, 16);
    this.reconnectAttempts++;
    console.log(`[nse-ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }
}
