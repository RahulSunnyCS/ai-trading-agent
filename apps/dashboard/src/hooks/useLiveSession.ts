/**
 * The Live page's data: the collected days to replay, and one day on the 1-minute grid
 * (live/session.py). A replayed day never changes, so it is fetched once and kept for the page
 * session; the page plays it back from memory. The live reader (BL-117 Phase 2) will answer the
 * same URL with the day so far and `intervalMs` will poll it then.
 */

import type { LiveDaysResponse, LiveSessionResponse, LiveUnderlying } from '../types/liveSession';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise/live';

export function useLiveDays(underlying: LiveUnderlying) {
  return usePolledResource<LiveDaysResponse>(`${BASE}/days?underlying=${underlying}`, {
    cache: true,
  });
}

/** `day` null asks for the newest collected day. */
export function useLiveSession(underlying: LiveUnderlying, day: string | null) {
  const query = day ? `underlying=${underlying}&day=${day}` : `underlying=${underlying}`;
  return usePolledResource<LiveSessionResponse>(`${BASE}/session?${query}`, { cache: true });
}
