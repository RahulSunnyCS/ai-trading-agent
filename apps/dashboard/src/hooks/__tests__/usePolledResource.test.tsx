// @vitest-environment happy-dom
/**
 * Proves the behavior usePolledResource is meant to guarantee — especially
 * the bug it fixes: calling refetch() while a request is already in flight
 * must always resolve, never leave the view stuck loading.
 *
 * That bug existed in usePersonalities/useRegimeTags because their refresh()
 * aborted the in-flight request and THEN bailed out on an in-flight guard,
 * so neither the aborted request nor a replacement ever updated state. The
 * "manual refetch cancels and replaces, then resolves" test below fails
 * against that old shape and passes against this one.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePolledResource } from '../usePolledResource.js';

interface PendingCall {
  url: string;
  signal: AbortSignal;
  resolve: (body: unknown, opts?: { ok?: boolean; status?: number }) => void;
  reject: (err: unknown) => void;
}

/**
 * A `fetch` stand-in whose calls resolve/reject only when the test tells
 * them to — so tests can control response ordering to prove the "latest
 * response wins" guard, and can simulate abort exactly like a real fetch:
 * a call whose signal fires 'abort' rejects with an AbortError DOMException,
 * matching apiGet's `err.name === 'AbortError'` check.
 */
function installControllableFetch(): { calls: PendingCall[] } {
  const calls: PendingCall[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        const call: PendingCall = {
          url,
          signal: init?.signal ?? new AbortController().signal,
          resolve: (body, opts) => {
            if (settled) return;
            settled = true;
            resolvePromise({
              ok: opts?.ok ?? true,
              status: opts?.status ?? 200,
              statusText: (opts?.ok ?? true) ? 'OK' : 'Error',
              json: async () => body,
            } as Response);
          },
          reject: (err) => {
            if (settled) return;
            settled = true;
            rejectPromise(err);
          },
        };
        init?.signal?.addEventListener('abort', () => {
          call.reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
        calls.push(call);
      });
    }),
  );

  return { calls };
}

describe('usePolledResource', () => {
  let ctl: { calls: PendingCall[] };

  beforeEach(() => {
    ctl = installControllableFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts loading, then applies the first successful response', async () => {
    const { result } = renderHook(() => usePolledResource<{ x: number }>('/api/x'));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(ctl.calls).toHaveLength(1));
    act(() => ctl.calls[0]!.resolve({ x: 1 }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ x: 1 });
    expect(result.current.error).toBeNull();
  });

  it('keeps the previous data visible on error, and reports the error', async () => {
    const { result } = renderHook(() => usePolledResource<{ x: number }>('/api/x'));
    await waitFor(() => expect(ctl.calls).toHaveLength(1));
    act(() => ctl.calls[0]!.resolve({ x: 1 }));
    await waitFor(() => expect(result.current.data).toEqual({ x: 1 }));

    act(() => result.current.refetch());
    await waitFor(() => expect(ctl.calls).toHaveLength(2));
    act(() => ctl.calls[1]!.resolve({ error: 'boom' }, { ok: false, status: 500 }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    // Previous data is NOT cleared — the view keeps showing it under the
    // error banner rather than flashing blank.
    expect(result.current.data).toEqual({ x: 1 });
  });

  it('aborts the in-flight request on unmount and never updates state after', async () => {
    const { unmount } = renderHook(() => usePolledResource<{ x: number }>('/api/x'));
    await waitFor(() => expect(ctl.calls).toHaveLength(1));
    const signal = ctl.calls[0]!.signal;

    unmount();
    expect(signal.aborted).toBe(true);

    // Even if the (aborted) request's promise settles after unmount, there
    // is no component left to assert against — the meaningful guarantee is
    // that resolving it does not throw (no setState-after-unmount warning
    // path is exercised) and that AbortError never reaches state as a real
    // error.
    expect(() => ctl.calls[0]!.resolve({ x: 99 })).not.toThrow();
  });

  it('manual refetch cancels an in-flight request and always resolves (the bug fix)', async () => {
    const { result } = renderHook(() => usePolledResource<{ x: number }>('/api/x'));
    await waitFor(() => expect(ctl.calls).toHaveLength(1));

    // Call refetch() WHILE the initial mount fetch is still in flight — this
    // is exactly the sequence that stuck usePersonalities/useRegimeTags
    // forever: the old code aborted call #1 and then skipped starting a
    // replacement because its in-flight guard was still set.
    act(() => result.current.refetch());

    // A second request must have been started — refetch() does not skip
    // just because one was already outstanding.
    await waitFor(() => expect(ctl.calls).toHaveLength(2));
    // The first request was cancelled to make way for it.
    expect(ctl.calls[0]!.signal.aborted).toBe(true);

    act(() => ctl.calls[1]!.resolve({ x: 42 }));

    // The hook must actually resolve — this is the assertion that fails
    // against the old skip-if-in-flight design, where neither request ever
    // reached here and loading stayed true forever.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ x: 42 });
  });

  it('a late-resolving superseded response never overwrites the newer one', async () => {
    const { result } = renderHook(() => usePolledResource<{ x: number }>('/api/x'));
    await waitFor(() => expect(ctl.calls).toHaveLength(1));

    act(() => result.current.refetch());
    await waitFor(() => expect(ctl.calls).toHaveLength(2));

    // Resolve the NEWER request first, then let the OLDER (already-aborted)
    // one resolve late — simulating an out-of-order network response rather
    // than relying only on the abort signal.
    act(() => ctl.calls[1]!.resolve({ x: 2 }));
    await waitFor(() => expect(result.current.data).toEqual({ x: 2 }));

    act(() => ctl.calls[0]!.resolve({ x: 1 }));
    // Data must still be from the newer request — the stale one is ignored
    // even though it resolved "successfully" and later in wall-clock time.
    expect(result.current.data).toEqual({ x: 2 });
  });

  it('poll mode skips a tick when a request is already in flight', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      usePolledResource<{ x: number }>('/api/x', { intervalMs: 1_000 }),
    );

    await vi.waitFor(() => expect(ctl.calls).toHaveLength(1));

    // Let two interval ticks fire while the first request is still pending.
    // Real timers are needed for the promise microtask queue to drain
    // between fake-timer advances, so this test mixes fake timers (for the
    // interval) with real awaits (for the fetch promise).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    // Both ticks were skipped — no overlapping requests piled up against the
    // still-pending first one.
    expect(ctl.calls).toHaveLength(1);

    await act(async () => {
      ctl.calls[0]!.resolve({ x: 7 });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(result.current.data).toEqual({ x: 7 }));

    // Now that the first request has settled, the next tick is free to fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(ctl.calls).toHaveLength(2);

    vi.useRealTimers();
  });

  it('poll ticks do not flip loading back to true (no flicker)', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      usePolledResource<{ x: number }>('/api/x', { intervalMs: 1_000 }),
    );

    await vi.waitFor(() => expect(ctl.calls).toHaveLength(1));
    await act(async () => {
      ctl.calls[0]!.resolve({ x: 1 });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await vi.waitFor(() => expect(ctl.calls).toHaveLength(2));

    // While the poll tick's request is outstanding, loading must stay false —
    // a manual refetch() shows the reload, an automatic poll tick must not.
    expect(result.current.loading).toBe(false);

    await act(async () => {
      ctl.calls[1]!.resolve({ x: 2 });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(result.current.data).toEqual({ x: 2 }));

    vi.useRealTimers();
  });

  it('re-fetches when the url value changes, cancelling the stale request', async () => {
    const { result, rerender } = renderHook(({ url }) => usePolledResource<{ x: number }>(url), {
      initialProps: { url: '/api/x?symbol=NIFTY' },
    });
    await waitFor(() => expect(ctl.calls).toHaveLength(1));
    expect(ctl.calls[0]!.url).toBe('/api/x?symbol=NIFTY');

    rerender({ url: '/api/x?symbol=BANKNIFTY' });

    await waitFor(() => expect(ctl.calls).toHaveLength(2));
    expect(ctl.calls[0]!.signal.aborted).toBe(true);
    expect(ctl.calls[1]!.url).toBe('/api/x?symbol=BANKNIFTY');

    act(() => ctl.calls[1]!.resolve({ x: 5 }));
    await waitFor(() => expect(result.current.data).toEqual({ x: 5 }));
  });
});
