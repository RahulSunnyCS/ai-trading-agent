// @vitest-environment happy-dom
/**
 * useFyersAuthStatus must only report `loading` for the very first request: a refetch on
 * window focus (or a poll) keeps the previous status on screen, which is what stops the
 * Broker logins card flipping to "Checking connection…" and hiding its Login button.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type FyersAuthStatus, fyersTokenState, useFyersAuthStatus } from '../useFyersAuthStatus';

interface PendingCall {
  url: string;
  resolve: (body: unknown, ok?: boolean) => void;
}

/** A fetch whose calls settle only when the test says so. */
function installControllableFetch(): PendingCall[] {
  const calls: PendingCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((resolvePromise, rejectPromise) => {
        calls.push({
          url,
          resolve: (body, ok = true) =>
            resolvePromise({
              ok,
              status: ok ? 200 : 500,
              statusText: ok ? 'OK' : 'Error',
              json: async () => body,
            } as Response),
        });
        init?.signal?.addEventListener('abort', () => {
          rejectPromise(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }),
  );
  return calls;
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

function connected(expiresAt: string): FyersAuthStatus {
  return {
    configured: true,
    connected: true,
    degraded: false,
    needsReauth: false,
    expiresAt,
    appId: 'APP-100',
  };
}

describe('useFyersAuthStatus', () => {
  let calls: PendingCall[];

  beforeEach(() => {
    calls = installControllableFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is loading only until the first response, then keeps the status through a focus refetch', async () => {
    const { result } = renderHook(() => useFyersAuthStatus());

    expect(result.current.loading).toBe(true);
    expect(result.current.status).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/auth/fyers/status');

    const first = connected(hoursFromNow(10));
    await act(async () => calls[0]?.resolve(first));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toEqual(first);
    expect(result.current.tokenState).toBe('valid');

    // Returning to the tab starts a refetch; nothing visible changes while it is in flight.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(calls).toHaveLength(2);
    expect(result.current.loading).toBe(false);
    expect(result.current.status).toEqual(first);
    expect(result.current.tokenState).toBe('valid');

    const second = connected(hoursFromNow(1));
    await act(async () => calls[1]?.resolve(second));
    await waitFor(() => expect(result.current.status).toEqual(second));
    expect(result.current.loading).toBe(false);
    expect(result.current.tokenState).toBe('expiring');
    expect(result.current.msLeft).toBeGreaterThan(0);
  });

  it('keeps the last status and reports the error when a refetch fails', async () => {
    const { result } = renderHook(() => useFyersAuthStatus());
    const first = connected(hoursFromNow(10));
    await act(async () => calls[0]?.resolve(first));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => calls[1]?.resolve({ error: 'boom' }, false));
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.status).toEqual(first);
    expect(result.current.loading).toBe(false);

    // The error stays up while the next attempt is in flight, and clears when it succeeds.
    act(() => result.current.refresh());
    expect(result.current.error).toBe('boom');
    await act(async () => calls[2]?.resolve(first));
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it('stops loading when the first request fails', async () => {
    const { result } = renderHook(() => useFyersAuthStatus());
    await act(async () => calls[0]?.resolve({ error: 'down' }, false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBeNull();
    expect(result.current.error).toBe('down');
    expect(result.current.tokenState).toBe('missing');
  });
});

describe('fyersTokenState', () => {
  const now = new Date('2026-10-05T03:00:00Z');
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();

  it('is missing without a status, without config, or without a token', () => {
    expect(fyersTokenState(null, now)).toBe('missing');
    expect(
      fyersTokenState(
        { configured: false, connected: false, degraded: true, needsReauth: true },
        now,
      ),
    ).toBe('missing');
    expect(
      fyersTokenState(
        { configured: true, connected: false, degraded: true, needsReauth: true },
        now,
      ),
    ).toBe('missing');
  });

  it('follows the expiry clock for a usable token', () => {
    expect(fyersTokenState(connected(at(10)), now)).toBe('valid');
    expect(fyersTokenState(connected(at(1)), now)).toBe('expiring');
  });

  it('is expired once past expiry, whatever the flags say', () => {
    expect(fyersTokenState(connected(at(-1)), now)).toBe('expired');
    expect(
      fyersTokenState({ ...connected(at(-1)), connected: false, needsReauth: true }, now),
    ).toBe('expired');
  });

  it('is missing for an unexpired token the server rejects (different app id)', () => {
    expect(
      fyersTokenState({ ...connected(at(10)), connected: false, needsReauth: true }, now),
    ).toBe('missing');
  });
});
