/**
 * useBackfillStatus — fetches GET /api/backfill on mount and returns the result.
 *
 * Built on usePolledResource: single fetch on mount, no polling (backfill
 * jobs run infrequently), and a `refresh` callback for the view to trigger
 * a re-fetch. This hook's own hand-rolled version was the one other hooks
 * should have copied — it already cancelled and replaced on refresh rather
 * than skipping while a request was in flight — so migrating it here changes
 * nothing about its behavior, only where the plumbing lives.
 */

import type { ApiEnvelope, BackfillRangeRow } from '../types/trading.js';
import { usePolledResource } from './usePolledResource.js';

export interface BackfillStatusState {
  ranges: BackfillRangeRow[];
  loading: boolean;
  error: string | null;
  /** Call to re-fetch with the same params without remounting. */
  refresh: () => void;
}

/**
 * Fetch backfill range records from GET /api/backfill.
 *
 * @param symbol  Optional symbol filter. When omitted, all symbols are returned.
 *
 * State transitions:
 *  - Initial mount        → loading: true, ranges: [], error: null
 *  - Successful 200       → loading: false, ranges: <array>, error: null
 *  - HTTP / network error → loading: false, ranges: [], error: <message>
 *  - Unmount (AbortError) → state is NOT updated
 */
export function useBackfillStatus(symbol?: string): BackfillStatusState {
  const params = new URLSearchParams();
  if (symbol) params.set('symbol', symbol);
  const qs = params.toString();

  const { data, loading, error, refetch } = usePolledResource<ApiEnvelope<BackfillRangeRow[]>>(
    `/api/backfill${qs ? `?${qs}` : ''}`,
  );

  return { ranges: data?.data ?? [], loading, error, refresh: refetch };
}
