/**
 * Pure helpers for the Live tab (components/LiveView.tsx + components/live/) and its socket
 * hook (hooks/useLiveTicks.ts): the bounded tick history, which ticks are the index, what the
 * feed's state reads as, and the one banner for broker-token trouble. No React, no fetching.
 *
 * Staleness is not decided here: it is `feedHealth` / `FEED_STALE_AFTER_MS` in lib/overview.ts,
 * so the Overview feed card and the Live tab can never disagree about it.
 */

import type { Tone } from '../components/ui/Badge';
import { type TokenState, formatCountdown } from './market';
import type { FeedHealth } from './overview';

// ---------------------------------------------------------------------------
// Tick history
// ---------------------------------------------------------------------------

/** How many points each history keeps: at ~1 tick/s, the last ten minutes of index ticks;
 * at one straddle snapshot per 15 s, the last two and a half hours of straddle values. */
export const TICK_BUFFER_CAP = 600;

/** The straddle calculator's snapshot cadence (apps/server straddle-calc.ts, default 15 s). */
export const STRADDLE_INTERVAL_MS = 15_000;

/** The symbol the ingestion pipeline publishes NIFTY 50 index ticks under. */
export const NIFTY_INDEX_SYMBOL = 'NSE:NIFTY50-INDEX';

export interface SeriesPoint {
  /** Epoch milliseconds. */
  time: number;
  value: number;
}

/**
 * `buffer` with `point` appended, keeping at most `cap` points (oldest dropped first). The
 * history stays in time order: a point older than the last one is ignored, and one with the
 * same time replaces it, so a duplicate frame (two sockets, a replayed message) is harmless.
 * Returns the same array when nothing changed, so a React state update can be skipped.
 */
export function appendPoint<T extends { time: number }>(
  buffer: readonly T[],
  point: T,
  cap: number = TICK_BUFFER_CAP,
): readonly T[] {
  if (cap <= 0) return [];
  const last = buffer[buffer.length - 1];
  if (last !== undefined && point.time < last.time) return buffer;
  if (last !== undefined && point.time === last.time) {
    return [...buffer.slice(0, -1), point];
  }
  const next = [...buffer, point];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Whether a /ws/ticks `tick` frame is the index. The socket forwards every tick on the
 * `market.ticks` stream, which also carries India VIX and the ATM CE / PE option legs; only
 * the index belongs on the index line. A frame without a symbol (an older server) is kept.
 */
export function isIndexTick(
  symbol: string | null | undefined,
  indexSymbol: string = NIFTY_INDEX_SYMBOL,
): boolean {
  if (symbol === null || symbol === undefined || symbol === '') return true;
  return symbol.toUpperCase() === indexSymbol.toUpperCase();
}

/**
 * Points for a Lightweight Charts line: one per whole second (the last value in that second
 * wins), ascending, with time in seconds. Lightweight Charts throws on a duplicate time.
 */
export function toChartSeries(points: readonly SeriesPoint[]): { time: number; value: number }[] {
  const bySecond = new Map<number, number>();
  for (const point of points) {
    if (!Number.isFinite(point.value) || !Number.isFinite(point.time)) continue;
    bySecond.set(Math.floor(point.time / 1000), point.value);
  }
  return Array.from(bySecond.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
}

// ---------------------------------------------------------------------------
// Feed state, in words
// ---------------------------------------------------------------------------

export interface FeedView {
  label: string;
  tone: Tone;
  pulse: boolean;
}

/** What a feed's health reads as on the Live tab (the same words as the Overview feed card). */
export const LIVE_FEED_VIEW: Record<FeedHealth, FeedView> = {
  live: { label: 'Live', tone: 'positive', pulse: true },
  stale: { label: 'Stale', tone: 'warning', pulse: false },
  waiting: { label: 'Waiting for ticks', tone: 'info', pulse: false },
  idle: { label: 'Idle', tone: 'neutral', pulse: false },
  connecting: { label: 'Connecting…', tone: 'neutral', pulse: true },
  disconnected: { label: 'Not connected', tone: 'negative', pulse: false },
};

/**
 * The badge beside a live value. Simulation says "Simulation" whenever its ticks are fresh,
 * so "Live" is only ever shown for real, fresh data; every other state says what is wrong.
 */
export function liveFeedView(health: FeedHealth, simulate: boolean): FeedView {
  if (simulate && health === 'live') return { label: 'Simulation', tone: 'info', pulse: true };
  return LIVE_FEED_VIEW[health];
}

// ---------------------------------------------------------------------------
// Token banner
// ---------------------------------------------------------------------------

export interface TokenBannerInput {
  /** From /api/meta; null until it has answered. */
  simulate: boolean | null;
  broker: string;
  /** The live feed reported an auth failure (/api/meta `authDegraded`). */
  authDegraded: boolean;
  /** Fyers login is configured on the server (/api/auth/fyers/status `configured`). */
  fyersConfigured: boolean;
  /** Where the Fyers token stands (useFyersAuthStatus). */
  tokenState: TokenState;
  msLeft: number | null;
}

export interface TokenBanner {
  /** `info` for simulation, `warning` for expiring or degraded, `negative` for expired / none. */
  tone: 'info' | 'warning' | 'negative';
  title: string;
  detail: string;
  /** Show the Fyers Login button. */
  canLogin: boolean;
}

function brokerName(broker: string): string {
  const name = broker.trim();
  if (name === '') return 'Broker';
  return name.toLowerCase() === 'fyers' ? 'Fyers' : name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The one banner over the Live tab, or null when there is nothing to say. Token trouble uses
 * one tone per severity everywhere: warning while the token is expiring or the feed reports
 * it degraded, negative once it has expired. The Fyers token only matters when the server's
 * broker is Fyers. "No stored token" is left to the top bar's status cluster: the server can
 * still be running on its FYERS_ACCESS_TOKEN fallback, which this status cannot see.
 */
export function tokenBanner(input: TokenBannerInput): TokenBanner | null {
  const { simulate, broker, authDegraded, fyersConfigured, tokenState, msLeft } = input;
  if (simulate === null) return null;
  if (simulate) {
    return {
      tone: 'info',
      title: 'Simulation',
      detail: 'The server runs its random-walk simulator: these are not real market prices.',
      canLogin: false,
    };
  }

  const name = brokerName(broker);
  const fyers = name === 'Fyers';
  const fyersTokenCounts = fyers && fyersConfigured;

  if (fyersTokenCounts && tokenState === 'expired') {
    return {
      tone: 'negative',
      title: 'Fyers token has expired',
      detail: 'The live feed cannot reconnect until you log in to Fyers again.',
      canLogin: true,
    };
  }
  if (authDegraded) {
    return {
      tone: 'warning',
      title: `${name} rejected the feed's token`,
      detail: fyers
        ? 'The live feed is degraded. Log in to Fyers again to restore it.'
        : `The live feed is degraded. Reconnect ${name} from Broker logins.`,
      canLogin: fyers,
    };
  }
  if (fyersTokenCounts && tokenState === 'expiring') {
    return {
      tone: 'warning',
      title: `Fyers token expires in ${formatCountdown(msLeft ?? 0)}`,
      detail: 'Log in again before it expires so the feed does not drop.',
      canLogin: true,
    };
  }
  return null;
}
