/**
 * useBackfillStatus — fetches GET /api/backfill on mount and returns the result.
 *
 * Design follows the usePaperTrades / useRegimeTags pattern:
 *  - Single fetch on mount with AbortController cleanup on unmount.
 *  - A manual `refresh` callback for the view to trigger a re-fetch.
 *  - No polling: backfill jobs run infrequently (historical data ingestion),
 *    so continuous polling would be wasted traffic.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet } from '../lib/api.js';
import type { ApiEnvelope, BackfillRangeRow } from '../types/trading.js';

// ---------------------------------------------------------------------------
// Public state shape
// ---------------------------------------------------------------------------

export interface BackfillStatusState {
  ranges: BackfillRangeRow[];
  loading: boolean;
  error: string | null;
  /** Call to re-fetch with the same params without remounting. */
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

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
  const [state, setState] = useState<Omit<BackfillStatusState, 'refresh'>>({
    ranges: [],
    loading: true,
    error: null,
  });

  const controllerRef = useRef<AbortController | null>(null);

  const fetch = useCallback(async () => {
    // Cancel any in-flight request; THIS call becomes the current one. We do not
    // bail when a request is already in flight — the latest refresh must always
    // win and always resolve `loading`, otherwise an aborted earlier request can
    // leave the spinner stuck on forever (a refresh that never settles).
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    // Build the query string — omit symbol when not provided.
    const params = new URLSearchParams();
    if (symbol) params.set('symbol', symbol);
    const qs = params.toString();

    const result = await apiGet<ApiEnvelope<BackfillRangeRow[]>>(
      `/api/backfill${qs ? `?${qs}` : ''}`,
      controller.signal,
    );

    // Ignore results from a request that was superseded by a newer fetch or
    // aborted on unmount — only the current controller may update state.
    if (controller.signal.aborted || controllerRef.current !== controller) return;

    if (!result.ok) {
      setState((prev) => ({ ...prev, loading: false, error: result.error }));
      return;
    }

    setState({
      ranges: result.data.data ?? [],
      loading: false,
      error: null,
    });
  }, [symbol]);

  useEffect(() => {
    void fetch();

    return () => {
      if (controllerRef.current) {
        controllerRef.current.abort();
      }
    };
  }, [fetch]);

  return { ...state, refresh: fetch };
}
