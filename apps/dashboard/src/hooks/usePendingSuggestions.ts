/**
 * usePendingSuggestions — fetches GET /api/retrospection/evolution/pending.
 *
 * These are evolution-engine-proposed parameter changes (one row per
 * personality+trade_date) that are waiting for human approval before being
 * written to personality_configs.params. The Personalities tab uses this as
 * an "approval inbox" surfacing the same data the API exposes for tooling.
 *
 * Same single-fetch-with-refresh shape as the other hooks; no polling — the
 * EOD retrospection job runs once per day at 16:00 IST, so refresh is enough.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet } from '../lib/api.js';
import type { ApiEnvelope, PendingSuggestion } from '../types/trading.js';

export interface PendingSuggestionsState {
  suggestions: PendingSuggestion[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function usePendingSuggestions(): PendingSuggestionsState {
  const [state, setState] = useState<Omit<PendingSuggestionsState, 'refresh'>>({
    suggestions: [],
    loading: true,
    error: null,
  });

  const controllerRef = useRef<AbortController | null>(null);

  const fetch = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    // Note: retrospection routes register WITHOUT the /api prefix (the plugin
    // is fastify-plugin-wrapped, which bypasses Fastify's `prefix` register
    // option). Hit the actual mount path.
    const result = await apiGet<ApiEnvelope<PendingSuggestion[]>>(
      '/retrospection/evolution/pending',
      controller.signal,
    );

    if (controller.signal.aborted || controllerRef.current !== controller) return;

    if (!result.ok) {
      setState((prev) => ({ ...prev, loading: false, error: result.error }));
      return;
    }

    setState({
      suggestions: result.data.data ?? [],
      loading: false,
      error: null,
    });
  }, []);

  useEffect(() => {
    void fetch();
    return () => {
      controllerRef.current?.abort();
    };
  }, [fetch]);

  return { ...state, refresh: fetch };
}
