/**
 * The Rotation page's Live board (BL-203): the snapshot `rotation/live_board.py` writes, polled
 * every minute (a file read upstream, not an Angel One call) and every 3 s from a Refresh click
 * until that refresh has finished. `refresh()` asks for one now: the 5-minute loop picks it up, or
 * the API runs one guarded Angel One login itself.
 */

import { useCallback, useEffect, useState } from 'react';

import { apiPost } from '../lib/api';
import { POLL_MS, POLL_REFRESHING_MS } from '../lib/rotationLiveBoard';
import type { LiveBoardRefreshResponse, LiveBoardResponse } from '../types/rotationLiveBoard';
import { usePolledResource } from './usePolledResource';

const URL = '/api/backtest/legwise/rotation/live-board';
/** Give up fast polling after this long even if no finish is seen (the loop may be mid-read). */
const FAST_FOR_MS = 5 * 60_000;

/** Whether the refresh asked for at `askedAt` has finished, by the state's last outcome. */
export function refreshDone(data: LiveBoardResponse | null, askedAt: number): boolean {
  if (!data || data.state.refreshing) return false;
  const done = [data.state.last_done_at, data.state.last_ok_at, data.state.last_error_at]
    .map((t) => (t ? Date.parse(t) : Number.NaN))
    .filter((t) => !Number.isNaN(t));
  return done.some((t) => t >= askedAt - 1000);
}

export function useRotationLiveBoard() {
  const [asking, setAsking] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const [fastPoll, setFastPoll] = useState(false);
  const res = usePolledResource<LiveBoardResponse>(URL, {
    intervalMs: fastPoll ? POLL_REFRESHING_MS : POLL_MS,
    cache: true,
  });
  const serverRefreshing = res.data?.state.refreshing ?? false;

  useEffect(() => {
    setFastPoll(askedAt !== null || serverRefreshing);
  }, [askedAt, serverRefreshing]);

  useEffect(() => {
    if (askedAt === null) return;
    if (refreshDone(res.data, askedAt) || Date.now() - askedAt > FAST_FOR_MS) setAskedAt(null);
  }, [res.data, askedAt]);

  const { refetch } = res;
  const refresh = useCallback(async () => {
    setAsking(true);
    setRefreshError(null);
    const out = await apiPost<LiveBoardRefreshResponse>(`${URL}/refresh`, {});
    setAsking(false);
    if (!out.ok) {
      setRefreshError(out.error);
      return;
    }
    setAskedAt(Date.now());
    refetch();
  }, [refetch]);

  return {
    data: res.data,
    loading: res.loading && res.data === null,
    error: res.error,
    refresh,
    refreshing: asking || askedAt !== null || serverRefreshing,
    refreshError,
  };
}
