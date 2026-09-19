/**
 * useBacktestRuns — fetches GET /api/backtest/runs on mount.
 *
 * `refresh` is called again after a successful run (see BacktestView) so the
 * past-runs table reflects the run that was just recorded, without a full
 * page reload. Built on usePolledResource.
 */

import type { RunSummary } from '../types/backtest.js';
import { usePolledResource } from './usePolledResource.js';

export interface BacktestRunsState {
  runs: RunSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useBacktestRuns(limit = 20): BacktestRunsState {
  const { data, loading, error, refetch } = usePolledResource<RunSummary[]>(
    `/api/backtest/runs?limit=${limit}`,
  );
  return { runs: data ?? [], loading, error, refresh: refetch };
}
