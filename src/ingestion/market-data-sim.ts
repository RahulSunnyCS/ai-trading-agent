// Market data simulator for development without real broker credentials.
// Generates realistic Nifty option tick data based on a random-walk spot price.
//
// Usage: set SIMULATE=true in .env — the main entry point will use this
// instead of the real NSE WebSocket feed.

import { updatePrice, buildOptionSymbol, getAtmStrike } from './straddle-calc';
import { setVix } from './vix-feed';
import type { Underlying } from '../db/schema';

interface SimConfig {
  underlying: Underlying;
  startSpot: number;
  startVix: number;
  tickIntervalMs: number;
}

const DEFAULT_CONFIG: SimConfig = {
  underlying:     'NIFTY',
  startSpot:      24000,
  startVix:       14.5,
  tickIntervalMs: 1_000,
};

// Simple straddle IV model:
// At-the-money straddle value ≈ 0.8 × spot × IV × sqrt(T)
// For a weekly option with ~1 day left: T ≈ 1/252
function atmStraddleValue(spot: number, vix: number): number {
  const iv  = vix / 100;
  const T   = 1 / 252;
  return 0.8 * spot * iv * Math.sqrt(T);
}

// Split straddle into CE and PE with a slight skew
function splitStraddle(straddleVal: number, spotVsAtm: number): { ce: number; pe: number } {
  const skew  = spotVsAtm * 0.3; // small directional bias
  const half  = straddleVal / 2;
  return {
    ce: Math.max(0.5, half - skew),
    pe: Math.max(0.5, half + skew),
  };
}

export class MarketDataSimulator {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private spot: number;
  private vix:  number;
  private readonly config: SimConfig;
  private currentExpiry: Date;

  constructor(config: Partial<SimConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.spot   = this.config.startSpot;
    this.vix    = this.config.startVix;
    this.currentExpiry = this.getNextExpiry();
  }

  start(): void {
    console.log(
      `[sim] Starting market data simulator — ${this.config.underlying} @ ${this.spot}, ` +
      `VIX ${this.vix}, tick every ${this.config.tickIntervalMs}ms`
    );
    setVix(this.vix);
    this.tick(); // immediate first tick
    this.intervalId = setInterval(() => this.tick(), this.config.tickIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private tick(): void {
    const underlying = this.config.underlying;

    // Random walk on spot: ±0.05% per tick with slight drift
    const drift       = 0.00001;
    const volatility  = 0.0005;
    const change      = drift + volatility * (Math.random() * 2 - 1);
    this.spot         = this.spot * (1 + change);

    // VIX moves slowly
    this.vix = Math.max(8, Math.min(40, this.vix + (Math.random() * 0.1 - 0.05)));
    setVix(this.vix);

    const atmStrike = getAtmStrike(this.spot, underlying);
    const spotVsAtm = this.spot - atmStrike;

    // Compute option prices for ATM and nearby strikes
    const strikesToSimulate = [
      atmStrike - 200,
      atmStrike - 100,
      atmStrike,
      atmStrike + 100,
      atmStrike + 200,
    ];

    for (const strike of strikesToSimulate) {
      // Moneyness-adjusted straddle value
      const moneyness     = Math.abs(this.spot - strike) / this.spot;
      const strikeVixAdj  = this.vix * (1 + moneyness * 2);
      const sv            = atmStraddleValue(this.spot, strikeVixAdj);
      const { ce, pe }    = splitStraddle(sv, spotVsAtm - (this.spot - strike));

      const ceSymbol = buildOptionSymbol(underlying, this.currentExpiry, strike, 'CE');
      const peSymbol = buildOptionSymbol(underlying, this.currentExpiry, strike, 'PE');

      updatePrice(ceSymbol, parseFloat(ce.toFixed(2)), new Date());
      updatePrice(peSymbol, parseFloat(pe.toFixed(2)), new Date());
    }

    // Also update a spot symbol so straddle-calc can find the current spot
    updatePrice(`${underlying}`, parseFloat(this.spot.toFixed(2)), new Date());
  }

  getSpot(): number {
    return this.spot;
  }

  getVix(): number {
    return this.vix;
  }

  getExpiry(): Date {
    return this.currentExpiry;
  }

  // NSE weekly options expire on Thursday
  private getNextExpiry(): Date {
    const now     = new Date();
    const day     = now.getDay(); // 0=Sun, 4=Thu
    const daysToThursday = (4 - day + 7) % 7 || 7;
    const expiry  = new Date(now);
    expiry.setDate(now.getDate() + daysToThursday);
    expiry.setHours(15, 30, 0, 0);
    return expiry;
  }
}
