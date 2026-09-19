/**
 * usePolledResource — shared GET-and-poll-or-refetch hook.
 *
 * Factors out a pattern that had been reimplemented, with small variations,
 * across roughly ten dashboard hooks: AbortController cleanup on unmount, a
 * guard against an out-of-order response overwriting a newer one, and
 * keeping the previous data on screen while an error banner shows instead
 * of blanking the view.
 *
 * Two concurrency policies, matching how each trigger is actually used:
 *
 *  - `refetch()` — including the initial mount fetch — always cancels
 *    whatever is in flight and starts a fresh request. This is what
 *    useBackfillStatus already did and got right. usePersonalities and
 *    useRegimeTags instead skipped starting a new request whenever one was
 *    already in flight; combined with aborting the old one first, calling
 *    refresh() during the initial mount fetch aborted that fetch AND
 *    skipped starting a replacement, so neither request ever updated state
 *    and the view was stuck on "loading" until an unrelated refresh call
 *    happened to succeed later. That bug is fixed by construction here.
 *
 *  - A poll tick (interval-driven) instead skips itself if a request is
 *    already in flight, so a slow endpoint does not pile up overlapping
 *    requests or — if it were cancel-and-restart like refetch() — abort
 *    itself forever without ever completing when the endpoint is slower
 *    than the interval.
 *
 * `url` is a plain string, recomputed by the caller on every render (e.g. a
 * template literal over query params) — there is no dependency array to get
 * wrong, unlike the useCallback([...params]) + useEffect([fetch]) pairing
 * every hook this replaces had to hand-write. The effect re-fetches
 * whenever `url`'s VALUE changes (strings compare by value, so this is safe
 * without memoizing the string itself).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet } from '../lib/api.js';

export interface PolledResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export interface PolledResourceResult<T> extends PolledResourceState<T> {
  /**
   * Re-fetch now. Cancels any in-flight request and always resolves — never
   * gets stuck even if called while a previous fetch (including the initial
   * mount fetch) is still pending.
   */
  refetch: () => void;
}

export interface UsePolledResourceOptions {
  /** Re-fetch on this interval, in addition to the initial mount fetch and
   * any manual refetch(). Omit for fetch-once-with-manual-refetch. */
  intervalMs?: number;
}

type FetchMode = 'manual' | 'poll';

export function usePolledResource<T>(
  url: string,
  opts: UsePolledResourceOptions = {},
): PolledResourceResult<T> {
  const { intervalMs } = opts;
  const [state, setState] = useState<PolledResourceState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  // Doubles as the in-flight guard for poll ticks (non-null = a request is
  // outstanding) and as the "am I still the current request" check for
  // deciding whether a resolved response is allowed to update state.
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (mode: FetchMode) => {
      if (mode === 'poll' && controllerRef.current) {
        // A request is already in flight — skip this tick rather than pile
        // up overlapping requests against a slow endpoint.
        return;
      }

      // Manual (including the initial mount call): cancel whatever is in
      // flight and take over. This is what makes refetch() always resolve.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'manual') {
        // Poll ticks deliberately do NOT flip loading back to true — doing
        // so would flicker the view every interval. A manual refetch (and
        // the initial mount call, which starts from loading: true anyway)
        // is a real "the view is reloading" event, so it does.
        setState((prev) => ({ ...prev, loading: true, error: null }));
      }

      const result = await apiGet<T>(url, controller.signal);

      // Ignore a response from a request that was superseded by a newer
      // refetch, or aborted on unmount — only the current controller may
      // update state. This subsumes checking `result.error === 'AbortError'`
      // and is stricter: it also protects against two back-to-back manual
      // refetch() calls resolving out of order.
      if (controllerRef.current !== controller) return;
      controllerRef.current = null;

      if (!result.ok) {
        if (result.error === 'AbortError') return;
        // Keep the previous data on screen; only loading/error change, so
        // the view does not flash blank while the error banner is shown.
        setState((prev) => ({ ...prev, loading: false, error: result.error }));
        return;
      }

      setState({ data: result.data, loading: false, error: null });
    },
    [url],
  );

  useEffect(() => {
    void run('manual');

    let timer: ReturnType<typeof setInterval> | undefined;
    if (intervalMs) {
      timer = setInterval(() => void run('poll'), intervalMs);
    }

    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      if (timer) clearInterval(timer);
    };
  }, [run, intervalMs]);

  const refetch = useCallback(() => void run('manual'), [run]);

  return { ...state, refetch };
}
