/**
 * usePendingSuggestions — fetches GET /retrospection/evolution/pending.
 *
 * These are evolution-engine-proposed parameter changes (one row per
 * personality+trade_date) that are waiting for human approval before being
 * written to personality_configs.params. The Personalities tab uses this as
 * an "approval inbox" surfacing the same data the API exposes for tooling.
 *
 * Single fetch with manual refresh; no polling — the EOD retrospection job
 * runs once per day at 16:00 IST, so refresh is enough. Built on
 * usePolledResource.
 */

import type { ApiEnvelope, PendingSuggestion } from '../types/trading.js';
import { usePolledResource } from './usePolledResource.js';

export interface PendingSuggestionsState {
  suggestions: PendingSuggestion[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function usePendingSuggestions(): PendingSuggestionsState {
  // Note: retrospection routes register WITHOUT the /api prefix (the plugin
  // is fastify-plugin-wrapped, which bypasses Fastify's `prefix` register
  // option). Hit the actual mount path.
  const { data, loading, error, refetch } = usePolledResource<ApiEnvelope<PendingSuggestion[]>>(
    '/retrospection/evolution/pending',
  );
  return { suggestions: data?.data ?? [], loading, error, refresh: refetch };
}
