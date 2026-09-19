/**
 * useBacktestPresets — fetches GET /api/backtest/presets on mount.
 *
 * Single fetch on mount, manual refresh. No polling — the preset list only
 * changes when new example strategies are committed to the repo. Built on
 * usePolledResource.
 */

import type { PresetSummary } from '../types/backtest.js';
import { usePolledResource } from './usePolledResource.js';

export interface BacktestPresetsState {
  presets: PresetSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useBacktestPresets(): BacktestPresetsState {
  const { data, loading, error, refetch } =
    usePolledResource<PresetSummary[]>('/api/backtest/presets');
  return { presets: data ?? [], loading, error, refresh: refetch };
}
