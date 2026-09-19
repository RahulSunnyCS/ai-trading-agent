/**
 * usePaperTrades — polls GET /api/trades on a ~10 s interval and returns a
 * normalised trade list.
 *
 * Design goals:
 *  - Centralised fetch logic: both TradesView (T-02) and PnlView (T-03) import
 *    this hook so the polling and normalisation code lives in exactly one place.
 *    Note: state is per-hook-instance, not shared across mounts. Mounting this
 *    hook in two places simultaneously would produce two independent polling
 *    loops. This is currently safe because App.tsx renders tabs exclusively
 *    (only one tab is mounted at a time). If both tabs were ever mounted
 *    simultaneously, the correct fix would be to lift the state into a Zustand
 *    store or a React context — not to duplicate the logic here.
 *  - Polling and cancellation live in usePolledResource — see that file for
 *    the concurrency contract (skip a poll tick if one is in flight; a manual
 *    refetch always cancels and replaces).
 */

import type { ApiEnvelope, PaperTrade } from '../types/trading.js';
import { usePolledResource } from './usePolledResource.js';

export interface PaperTradesState {
  trades: PaperTrade[];
  loading: boolean;
  error: string | null;
}

/**
 * Polling interval in milliseconds.
 * 10 000 ms (~10 s) is a reasonable balance between freshness and server load
 * for a paper-trading dashboard that updates every few minutes in practice.
 */
const POLL_INTERVAL_MS = 10_000;

/**
 * Polls /api/trades on a ~10 s interval.
 *
 * State transitions:
 *
 *   Initial mount        → loading: true, trades: [], error: null
 *   Successful 200       → loading: false, trades: <array>, error: null
 *   Successful but empty → loading: false, trades: [], error: null
 *   HTTP / network error → loading: false, trades: <previous>, error: <message>
 *   Unmount (AbortError) → state is NOT updated (component is gone)
 *
 * The `trades` array is never reset to [] on a subsequent error — consumers
 * continue to see the last good data while the error banner is shown.
 */
export function usePaperTrades(): PaperTradesState {
  const { data, loading, error } = usePolledResource<ApiEnvelope<PaperTrade[]>>('/api/trades', {
    intervalMs: POLL_INTERVAL_MS,
  });
  return { trades: data?.data ?? [], loading, error };
}
