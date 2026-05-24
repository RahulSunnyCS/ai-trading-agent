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
 *  - No overlapping requests: if a poll is still in-flight when the next
 *    tick fires, the new tick is skipped entirely (not queued).
 *  - Clean unmount: the AbortController cancels the in-flight fetch and the
 *    interval is cleared, so React never tries to call setState on an
 *    unmounted component.
 *  - Abort ≠ error: a request aborted during cleanup is silently ignored —
 *    only genuine network/HTTP failures enter the ERROR state.
 */

import { useEffect, useRef, useState } from 'react';

import { apiGet } from '../lib/api.js';
import { type ApiEnvelope, type PaperTrade } from '../types/trading.js';

// ---------------------------------------------------------------------------
// Return type — exported so consumers can annotate state variables if needed.
// ---------------------------------------------------------------------------

export interface PaperTradesState {
  trades: PaperTrade[];
  loading: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Polling interval in milliseconds.
 * 10 000 ms (~10 s) is a reasonable balance between freshness and server load
 * for a paper-trading dashboard that updates every few minutes in practice.
 */
const POLL_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

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
  const [state, setState] = useState<PaperTradesState>({
    trades: [],
    loading: true,
    error: null,
  });

  /**
   * Guard flag: true while an in-flight request is pending.
   * We use a ref (not state) so toggling it never triggers a re-render and we
   * can safely read/write it inside the closure without stale-closure problems.
   */
  const inFlightRef = useRef(false);

  useEffect(() => {
    // One AbortController per effect lifecycle (mount → unmount).
    // We do not create a new controller per poll — that would create
    // a fresh signal for every interval tick and we would lose the ability to
    // abort the currently in-flight request at unmount time.
    const controller = new AbortController();
    const { signal } = controller;

    /**
     * Execute one poll cycle.
     * If a request is already in-flight, this is a no-op.
     */
    async function poll(): Promise<void> {
      // Skip this tick if a prior request has not finished yet.
      if (inFlightRef.current) return;

      inFlightRef.current = true;

      const result = await apiGet<ApiEnvelope<PaperTrade[]>>('/api/trades', signal);

      inFlightRef.current = false;

      // A request aborted during cleanup (unmount) must NOT update state.
      // apiGet surfaces AbortError as { ok: false, error: 'AbortError' }.
      if (!result.ok && result.error === 'AbortError') return;

      if (!result.ok) {
        // Genuine HTTP / network failure → enter error state.
        // We keep the previous `trades` array so the table does not flash blank
        // while the banner is shown (better UX than clearing the list).
        setState((prev) => ({
          ...prev,
          loading: false,
          error: result.error,
        }));
        return;
      }

      // Successful response — normalise the envelope.
      // The server returns { data: PaperTrade[] } both for non-empty and empty
      // arrays (with an optional `message` on empty).  We treat both the same:
      // the array is the source of truth, not the presence of `message`.
      const trades = result.data.data ?? [];

      setState({
        trades,
        loading: false,
        error: null,
      });
    }

    // Fire the first poll immediately (do not wait 10 s for initial data).
    void poll();

    // Schedule subsequent polls on the interval.
    const timerId = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    // Cleanup: abort in-flight request and stop the interval.
    return () => {
      controller.abort();
      clearInterval(timerId);
    };
  }, []); // Empty deps — single polling loop for the lifetime of the component.

  return state;
}
