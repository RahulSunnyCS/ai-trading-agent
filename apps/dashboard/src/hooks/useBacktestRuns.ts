/**
 * useBacktestRuns — fetches GET /api/backtest/runs on mount: the YAML engine's run
 * registry, listed in Options Lab › Runs. Built on usePolledResource.
 *
 * useBacktestRun — GET /api/backtest/runs/:id, one stored run. The registry keeps a run's
 * headline figures only (the same shape as a list row): no per-session rows.
 */

import type { RunSummary } from '../types/backtest';
import { usePolledResource } from './usePolledResource';

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

export interface BacktestRunState {
  run: RunSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Mount the component that calls this only once a run is selected: it always fetches. */
export function useBacktestRun(runId: string): BacktestRunState {
  const { data, loading, error, refetch } = usePolledResource<RunSummary>(
    `/api/backtest/runs/${encodeURIComponent(runId)}`,
  );
  return { run: data, loading, error, refresh: refetch };
}
