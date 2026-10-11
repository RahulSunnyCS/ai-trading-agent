/**
 * Options Lab › Heatmap data (BL-094). The grids are rebuilt after each collected day, so a view
 * is fetched when its settings change and on Refresh, never polled.
 */

import type { HeatmapAvailable, HeatmapResponse } from '../types/heatmap';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise/heatmap';

export interface HeatmapParams {
  underlying: string;
  view: string;
  date?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  sl?: number | undefined;
  time?: string | undefined;
  exit: string;
  weeks?: number[] | undefined;
  metric: string;
}

export function heatmapUrl(p: HeatmapParams): string {
  const q = new URLSearchParams();
  q.set('underlying', p.underlying);
  q.set('view', p.view);
  q.set('exit', p.exit);
  q.set('metric', p.metric);
  if (p.date) q.set('date', p.date);
  if (p.from) q.set('from', p.from);
  if (p.to) q.set('to', p.to);
  if (p.sl !== undefined) q.set('sl', String(p.sl));
  if (p.time) q.set('time', p.time);
  if (p.weeks && p.weeks.length > 0) q.set('weeks', p.weeks.join(','));
  return `${BASE}?${q.toString()}`;
}

export function useHeatmapAvailable() {
  return usePolledResource<HeatmapAvailable>(`${BASE}/available`, { cache: true });
}

export function useHeatmap(params: HeatmapParams) {
  return usePolledResource<HeatmapResponse>(heatmapUrl(params));
}
