/**
 * useRegimeTags — fetches GET /api/regime-tags on mount and returns the result.
 *
 * Design follows the usePaperTrades pattern:
 *  - Fetch on mount; AbortController cancels the in-flight request on unmount
 *    so React never calls setState on an unmounted component.
 *  - AbortError is silently ignored (not an error state).
 *  - A manual `refresh` callback is exposed so the view can trigger a re-fetch
 *    (e.g. after the user changes the symbol/date filters).
 *  - No polling interval: regime tags change only after the EOD retrospection
 *    job runs, so continuous polling would be wasted traffic.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet } from '../lib/api.js';
import type { ApiEnvelope, RegimeTag } from '../types/trading.js';

// ---------------------------------------------------------------------------
// Public state shape
// ---------------------------------------------------------------------------

export interface RegimeTagsState {
  tags: RegimeTag[];
  loading: boolean;
  error: string | null;
  /** Call to re-fetch with the same params without remounting. */
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Fetch daily regime tags from GET /api/regime-tags.
 *
 * @param symbol  Underlying symbol to query (default: 'NIFTY').
 * @param from    YYYY-MM-DD start date (optional; server defaults to 30 days ago).
 * @param to      YYYY-MM-DD end date (optional; server defaults to today).
 *
 * State transitions mirror usePaperTrades:
 *  - Initial mount        → loading: true, tags: [], error: null
 *  - Successful 200       → loading: false, tags: <array>, error: null
 *  - HTTP / network error → loading: false, tags: [], error: <message>
 *  - Unmount (AbortError) → state is NOT updated
 */
export function useRegimeTags(symbol = 'NIFTY', from?: string, to?: string): RegimeTagsState {
  const [state, setState] = useState<Omit<RegimeTagsState, 'refresh'>>({
    tags: [],
    loading: true,
    error: null,
  });

  // Guard flag: prevents concurrent in-flight fetches if refresh is called
  // rapidly (mirrors the inFlightRef guard in usePaperTrades).
  const inFlightRef = useRef(false);

  // We keep the AbortController in a ref so the refresh callback can abort
  // the current request and start a fresh one without remounting the hook.
  const controllerRef = useRef<AbortController | null>(null);

  const fetch = useCallback(async () => {
    // Abort any previous in-flight request before starting a new one.
    if (controllerRef.current) {
      controllerRef.current.abort();
    }

    if (inFlightRef.current) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    inFlightRef.current = true;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    // Build query string — omit undefined params so the server uses its defaults.
    const params = new URLSearchParams({ symbol });
    if (from) params.set('from', from);
    if (to) params.set('to', to);

    const result = await apiGet<ApiEnvelope<RegimeTag[]>>(
      `/api/regime-tags?${params.toString()}`,
      controller.signal,
    );

    inFlightRef.current = false;

    if (!result.ok && result.error === 'AbortError') return;

    if (!result.ok) {
      setState((prev) => ({ ...prev, loading: false, error: result.error }));
      return;
    }

    setState({
      tags: result.data.data ?? [],
      loading: false,
      error: null,
    });
  }, [symbol, from, to]);

  useEffect(() => {
    void fetch();

    return () => {
      // Abort in-flight request on unmount.
      if (controllerRef.current) {
        controllerRef.current.abort();
      }
    };
  }, [fetch]);

  return { ...state, refresh: fetch };
}
