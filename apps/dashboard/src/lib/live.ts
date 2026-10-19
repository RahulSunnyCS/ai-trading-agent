/**
 * Pure helpers for the tick socket hook (hooks/useLiveTicks.ts, read by the Overview feed card):
 * the bounded tick history and which ticks are the index. No React, no fetching.
 *
 * Staleness is not decided here: it is `feedHealth` / `FEED_STALE_AFTER_MS` in lib/overview.ts.
 * The Live page no longer uses the socket (it reads lib/liveSession.ts).
 */

/** How many points each history keeps: at ~1 tick/s, the last ten minutes of index ticks;
 * at one straddle snapshot per 15 s, the last two and a half hours of straddle values. */
export const TICK_BUFFER_CAP = 600;

/** The symbol the ingestion pipeline publishes NIFTY 50 index ticks under. */
export const NIFTY_INDEX_SYMBOL = 'NSE:NIFTY50-INDEX';

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
