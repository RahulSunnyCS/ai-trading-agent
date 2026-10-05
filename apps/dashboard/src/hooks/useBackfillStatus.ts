/**
 * useBackfillStatus — fetches GET /api/backfill on mount and returns the result.
 *
 * Built on usePolledResource. It fetches once on mount and on `refresh`, and polls every
 * BACKFILL_POLL_MS while any row is in progress (or while a just-queued job is being watched
 * for, see `watchForNewJob`), then stops again once every row has settled.
 */

import { useCallback, useEffect, useState } from 'react';

import { BACKFILL_POLL_MS, shouldPollBackfill } from '../lib/backfill';
import type { ApiEnvelope, BackfillRangeRow } from '../types/trading';
import { usePolledResource } from './usePolledResource';

/** How long after queueing a job the view keeps polling for its row to appear. */
const WATCH_NEW_JOB_MS = 30_000;

export interface BackfillStatusState {
  ranges: BackfillRangeRow[];
  loading: boolean;
  error: string | null;
  /** Call to re-fetch with the same params without remounting. */
  refresh: () => void;
  /** True while the table is re-reading the endpoint on a timer. */
  polling: boolean;
  /** Re-fetch now and keep polling for a while, so a job just queued shows up by itself. */
  watchForNewJob: () => void;
}

/**
 * Fetch backfill range records from GET /api/backfill.
 *
 * @param symbol  Optional symbol filter. When omitted, all symbols are returned.
 *
 * State transitions:
 *  - Initial mount        → loading: true, ranges: [], error: null
 *  - Successful 200       → loading: false, ranges: <array>, error: null
 *  - HTTP / network error → loading: false, ranges: [], error: <message>
 *  - Unmount (AbortError) → state is NOT updated
 */
export function useBackfillStatus(symbol?: string): BackfillStatusState {
  const params = new URLSearchParams();
  if (symbol) params.set('symbol', symbol);
  const qs = params.toString();

  // Whether to poll depends on the rows the last answer carried, so it is held in state and
  // re-derived after each answer (and each poll tick re-renders, which re-checks the watch).
  const [polling, setPolling] = useState(false);
  const [watchUntil, setWatchUntil] = useState<number | null>(null);

  const { data, loading, error, refetch } = usePolledResource<ApiEnvelope<BackfillRangeRow[]>>(
    `/api/backfill${qs ? `?${qs}` : ''}`,
    polling ? { intervalMs: BACKFILL_POLL_MS } : {},
  );
  const ranges = data?.data ?? [];

  useEffect(() => {
    setPolling(shouldPollBackfill(data?.data ?? [], watchUntil, Date.now()));
  }, [data, watchUntil]);

  const watchForNewJob = useCallback(() => {
    setWatchUntil(Date.now() + WATCH_NEW_JOB_MS);
    refetch();
  }, [refetch]);

  return { ranges, loading, error, refresh: refetch, polling, watchForNewJob };
}
