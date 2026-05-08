import { query } from '../db/client';

// India VIX is published by NSE. The canonical free source is the NSE website
// at https://www.nseindia.com/api/allIndices but requires a session cookie.
// Broker APIs (Zerodha, Upstox) expose VIX as an instrument tick.
//
// This module provides:
//   1. pollVix()     — fetches VIX from broker feed (pluggable)
//   2. getLatestVix() — returns the last known VIX value from in-memory cache

let latestVix: number | null = null;
let lastVixFetchAt: Date | null = null;

export function getLatestVix(): number | null {
  return latestVix;
}

export function setVix(value: number): void {
  latestVix = value;
  lastVixFetchAt = new Date();
}

// ── VIX Poller ────────────────────────────────────────────────────────────────
// In production: VIX comes as a tick from the broker WebSocket for symbol "INDIA VIX".
// This poller is a fallback for when broker feed doesn't include VIX as a tick.

export interface VixFetchFn {
  (): Promise<number | null>;
}

export class VixFeed {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly fetchFn: VixFetchFn;
  private readonly intervalMs: number;

  constructor(fetchFn: VixFetchFn, intervalMs = 60_000) {
    this.fetchFn   = fetchFn;
    this.intervalMs = intervalMs;
  }

  start(): void {
    // Fetch immediately on start
    this.fetch();
    this.intervalId = setInterval(() => this.fetch(), this.intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async fetch(): Promise<void> {
    try {
      const vix = await this.fetchFn();
      if (vix !== null && vix > 0) {
        setVix(vix);
        await this.persist(vix);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[vix-feed] Fetch error:', msg);
    }
  }

  private async persist(vix: number): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    await query(
      `INSERT INTO external_signals (signal_date, signal_type, source, data, relevance)
       VALUES ($1, 'VIX', 'india_vix', $2, 1.0)`,
      [today, JSON.stringify({ vix, recorded_at: new Date().toISOString() })]
    );
  }
}

// ── NSE Website fetch (best-effort, no auth required for public index data) ──

export async function fetchVixFromNse(): Promise<number | null> {
  try {
    const res = await fetch('https://www.nseindia.com/api/allIndices', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept:       'application/json',
        Referer:      'https://www.nseindia.com/',
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) return null;
    const json = await res.json() as { data?: Array<{ index: string; last: number }> };
    const vixEntry = json.data?.find((d) => d.index === 'India VIX');
    return vixEntry?.last ?? null;
  } catch {
    return null;
  }
}
