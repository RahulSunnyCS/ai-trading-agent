/**
 * useBacktestRuns — fetches GET /api/backtest/runs on mount.
 *
 * `refresh` is called again after a successful run (see BacktestView) so the
 * past-runs table reflects the run that was just recorded, without a full
 * page reload.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet } from '../lib/api.js';
import type { RunSummary } from '../types/backtest.js';

export interface BacktestRunsState {
  runs: RunSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useBacktestRuns(limit = 20): BacktestRunsState {
  const [state, setState] = useState<Omit<BacktestRunsState, 'refresh'>>({
    runs: [],
    loading: true,
    error: null,
  });

  const controllerRef = useRef<AbortController | null>(null);

  const fetchRuns = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    const result = await apiGet<RunSummary[]>(
      `/api/backtest/runs?limit=${limit}`,
      controller.signal,
    );

    if (controller.signal.aborted || controllerRef.current !== controller) return;

    if (!result.ok) {
      setState((prev) => ({ ...prev, loading: false, error: result.error }));
      return;
    }

    setState({ runs: result.data, loading: false, error: null });
  }, [limit]);

  useEffect(() => {
    void fetchRuns();
    return () => controllerRef.current?.abort();
  }, [fetchRuns]);

  return { ...state, refresh: fetchRuns };
}
