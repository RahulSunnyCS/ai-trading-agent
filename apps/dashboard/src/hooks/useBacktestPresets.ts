/**
 * useBacktestPresets — fetches GET /api/backtest/presets on mount.
 *
 * Same shape as useBackfillStatus: single fetch on mount, AbortController
 * cleanup, manual refresh. No polling — the preset list only changes when
 * new example strategies are committed to the repo.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet } from '../lib/api.js';
import type { PresetSummary } from '../types/backtest.js';

export interface BacktestPresetsState {
  presets: PresetSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useBacktestPresets(): BacktestPresetsState {
  const [state, setState] = useState<Omit<BacktestPresetsState, 'refresh'>>({
    presets: [],
    loading: true,
    error: null,
  });

  const controllerRef = useRef<AbortController | null>(null);

  const fetchPresets = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    const result = await apiGet<PresetSummary[]>('/api/backtest/presets', controller.signal);

    if (controller.signal.aborted || controllerRef.current !== controller) return;

    if (!result.ok) {
      setState((prev) => ({ ...prev, loading: false, error: result.error }));
      return;
    }

    setState({ presets: result.data, loading: false, error: null });
  }, []);

  useEffect(() => {
    void fetchPresets();
    return () => controllerRef.current?.abort();
  }, [fetchPresets]);

  return { ...state, refresh: fetchPresets };
}
