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
 * Poll ticks are skipped while the browser tab is hidden (`document.hidden`); when it becomes
 * visible again after at least one skipped tick, the hook fetches at once and the interval
 * carries on. The mount fetch and refetch() run whatever the visibility.
 *
 * Hook instances share one in-flight request per URL: three components mounting /api/meta at
 * once make one request. The mount fetch and poll ticks join a request that is already in
 * flight for the URL; refetch() always starts a fresh one (the caller usually wants an answer
 * from after something it just did). An instance that unmounts or moves on only drops its
 * interest — the shared request is aborted once no instance is waiting for it.
 *
 * `url` is a plain string, recomputed by the caller on every render (e.g. a
 * template literal over query params) — there is no dependency array to get
 * wrong, unlike the useCallback([...params]) + useEffect([fetch]) pairing
 * every hook this replaces had to hand-write. The effect re-fetches
 * whenever `url`'s VALUE changes (strings compare by value, so this is safe
 * without memoizing the string itself).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { type ApiResult, apiGet } from '../lib/api';

/** Last successful response per URL, for callers that opt in with `cache: true`. Lives for the
 * page session only: it makes coming back to a view instant, never replaces the revalidation. */
const responseCache = new Map<string, unknown>();

/** One GET shared by every hook instance waiting for the same URL. */
interface SharedRequest {
  controller: AbortController;
  promise: Promise<ApiResult<unknown>>;
  /** Instances still waiting for it; aborted when this drops to zero before it settles. */
  subscribers: number;
  settled: boolean;
}

/** The request in flight per URL, joined by the mount fetch and poll ticks of every instance. */
const inflight = new Map<string, SharedRequest>();

/**
 * One-off GET that shares `usePolledResource`'s cache: answers from it when this URL has
 * already been loaded (by either), otherwise fetches and stores. For data a view needs once
 * and does not have to be the very latest — e.g. autocomplete suggestions.
 */
export async function fetchCached<T>(url: string): Promise<ApiResult<T>> {
  if (responseCache.has(url)) return { ok: true, data: responseCache.get(url) as T };
  const result = await apiGet<T>(url);
  if (result.ok) responseCache.set(url, result.data);
  return result;
}

/** Test seam: forget cached responses (and any shared in-flight request) between tests. */
export function clearPolledResourceCache(): void {
  responseCache.clear();
  inflight.clear();
}

/** Join the request in flight for `url`, or start one (always, when `fresh`). */
function acquire(url: string, fresh: boolean): SharedRequest {
  const existing = inflight.get(url);
  if (existing && !fresh) {
    existing.subscribers += 1;
    return existing;
  }
  const controller = new AbortController();
  const entry: SharedRequest = {
    controller,
    subscribers: 1,
    settled: false,
    promise: apiGet<unknown>(url, controller.signal).then((result) => {
      entry.settled = true;
      if (inflight.get(url) === entry) inflight.delete(url);
      return result;
    }),
  };
  inflight.set(url, entry);
  return entry;
}

/** Drop one instance's interest; abort the request when nobody else is waiting for it. */
function release(url: string, entry: SharedRequest): void {
  entry.subscribers -= 1;
  if (entry.subscribers > 0 || entry.settled) return;
  if (inflight.get(url) === entry) inflight.delete(url);
  entry.controller.abort();
}

function tabHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

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
  /** Start from the last response for this URL (kept in memory for the session), so a view
   * that re-mounts — switching sections and back — shows its data at once instead of a
   * loading state. It still re-fetches as usual; `loading` is true until that lands. */
  cache?: boolean;
}

/** `mount` (and a url change) joins a shared in-flight request, `manual` (refetch) always
 * starts a fresh one, `poll` joins and skips itself when this instance is already waiting. */
type FetchMode = 'mount' | 'manual' | 'poll';

interface Subscription {
  url: string;
  entry: SharedRequest;
}

export function usePolledResource<T>(
  url: string,
  opts: UsePolledResourceOptions = {},
): PolledResourceResult<T> {
  const { intervalMs, cache = false } = opts;
  const [state, setState] = useState<PolledResourceState<T>>(() => ({
    data: cache && responseCache.has(url) ? (responseCache.get(url) as T) : null,
    loading: true,
    error: null,
  }));

  // In-flight guard for poll ticks (non-null = waiting) and the "am I still the current
  // request" check. A fresh object per run, so two runs on one shared request differ.
  const currentRef = useRef<Subscription | null>(null);
  // A poll tick was skipped while the tab was hidden: fetch as soon as it is visible again.
  const missedTickRef = useRef(false);

  const dropCurrent = useCallback(() => {
    const current = currentRef.current;
    currentRef.current = null;
    if (current) release(current.url, current.entry);
  }, []);

  const run = useCallback(
    async (mode: FetchMode) => {
      if (mode === 'poll') {
        // A request is already in flight — skip this tick rather than pile up overlapping
        // requests against a slow endpoint.
        if (currentRef.current) return;
        if (tabHidden()) {
          missedTickRef.current = true;
          return;
        }
      }

      // Mount/manual: cancel (drop interest in) whatever this instance was waiting for and
      // take over. This is what makes refetch() always resolve.
      dropCurrent();
      const subscription: Subscription = { url, entry: acquire(url, mode === 'manual') };
      currentRef.current = subscription;

      if (mode !== 'poll') {
        // Poll ticks deliberately do NOT flip loading back to true — doing
        // so would flicker the view every interval. A manual refetch (and
        // the initial mount call, which starts from loading: true anyway)
        // is a real "the view is reloading" event, so it does. A cached response for a new
        // url replaces the previous url's data straight away.
        setState((prev) => ({
          data: cache && responseCache.has(url) ? (responseCache.get(url) as T) : prev.data,
          loading: true,
          error: null,
        }));
      }

      const result = (await subscription.entry.promise) as ApiResult<T>;

      // Ignore a response from a request that was superseded by a newer
      // refetch, or dropped on unmount — only the current subscription may
      // update state. This subsumes checking `result.error === 'AbortError'`
      // and is stricter: it also protects against two back-to-back manual
      // refetch() calls resolving out of order.
      if (currentRef.current !== subscription) return;
      dropCurrent();

      if (!result.ok) {
        if (result.error === 'AbortError') return;
        // Keep the previous data on screen; only loading/error change, so
        // the view does not flash blank while the error banner is shown.
        setState((prev) => ({ ...prev, loading: false, error: result.error }));
        return;
      }

      if (cache) responseCache.set(url, result.data);
      setState({ data: result.data, loading: false, error: null });
    },
    [url, cache, dropCurrent],
  );

  useEffect(() => {
    void run('mount');

    let timer: ReturnType<typeof setInterval> | undefined;
    let onVisibility: (() => void) | undefined;
    if (intervalMs) {
      timer = setInterval(() => void run('poll'), intervalMs);
      onVisibility = () => {
        if (tabHidden() || !missedTickRef.current) return;
        missedTickRef.current = false;
        void run('poll');
      };
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      dropCurrent();
      if (timer) clearInterval(timer);
      if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [run, intervalMs, dropCurrent]);

  const refetch = useCallback(() => void run('manual'), [run]);

  return { ...state, refetch };
}
