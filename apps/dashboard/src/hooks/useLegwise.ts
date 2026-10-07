/**
 * Data hooks for the Options Lab tab, all built on usePolledResource and all
 * behind the Fastify proxy (/api/backtest/legwise/*).
 */

import { useState } from 'react';

import type {
  AnatomyResponse,
  DailyJob,
  DataStatus,
  DayForensics,
  ResultsResponse,
  SavedStrategy,
} from '../types/legwise';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise';

export function useLegwiseStrategies() {
  return usePolledResource<SavedStrategy[]>(`${BASE}/strategies`);
}

export function useLegwiseResults() {
  return usePolledResource<ResultsResponse>(`${BASE}/results`);
}

export function useLegwiseData() {
  return usePolledResource<DataStatus>(`${BASE}/data`);
}

/**
 * The evening run's state. Fetched once on mount, then polled — every 2s by default, so the
 * log streams in — only while a run is going. A view that only shows the job's state
 * (Overview) passes a slower interval. After starting a run, call `refetch()`: the API marks
 * the job running before it answers the POST, so that fetch sees it and polling resumes.
 */
export function useDailyJob(intervalMs = 2000) {
  const [polling, setPolling] = useState(false);
  const resource = usePolledResource<DailyJob>(`${BASE}/daily`, polling ? { intervalMs } : {});
  const running = resource.data?.state === 'running';
  // React's "adjust state while rendering" pattern, as in useMomentumWeeklyJob.
  if (polling !== running) setPolling(running);
  return resource;
}

/** Cut times as the API wants them: '10:30,13:30'. */
export const DEFAULT_CUTS = ['10:30', '13:30'] as const;

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const text = q.toString();
  return text ? `?${text}` : '';
}

/**
 * One saved day re-simulated server-side (MTM curve, markers, per-leg attribution).
 * `sha` pins the strategy version that produced the saved result. Mount a component
 * that calls this only once a day is selected — usePolledResource always fetches.
 */
export function useDayForensics(
  strategy: string,
  day: string,
  sha: string | undefined,
  cuts: readonly string[] = DEFAULT_CUTS,
) {
  return usePolledResource<DayForensics>(
    `${BASE}/day${query({ strategy, day, sha, cuts: cuts.join(',') })}`,
  );
}

/** Per-day, per-segment index anatomy over the collected index history. */
export function useAnatomy(
  underlying = 'NIFTY',
  cuts: readonly string[] = DEFAULT_CUTS,
  range: { from?: string | undefined; to?: string | undefined } = {},
) {
  return usePolledResource<AnatomyResponse>(
    `${BASE}/anatomy${query({ underlying, cuts: cuts.join(','), ...range })}`,
  );
}

export const LEGWISE_API = BASE;
