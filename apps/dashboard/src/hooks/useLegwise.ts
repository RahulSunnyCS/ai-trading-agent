/**
 * Data hooks for the Options Lab tab, all built on usePolledResource and all
 * behind the Fastify proxy (/api/backtest/legwise/*).
 */

import type { DailyJob, DataStatus, ResultsResponse, SavedStrategy } from '../types/legwise.js';
import { usePolledResource } from './usePolledResource.js';

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

/** Polls every 2s so the evening run's log streams in while it collects. */
export function useDailyJob() {
  return usePolledResource<DailyJob>(`${BASE}/daily`, { intervalMs: 2000 });
}

export const LEGWISE_API = BASE;
