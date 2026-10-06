/**
 * useFyersAuthStatus — GET /api/auth/fyers/status on mount, every 60 s, and whenever the
 * window regains focus.
 *
 * The focus refetch is intentional: after the user completes the Fyers OAuth login in a new
 * tab and switches back, the status refreshes without a manual button press.
 *
 * Only the very first load reports `loading`. A later refetch (focus or poll) keeps the
 * previous status — and the previous error — on screen until the new answer lands, so the
 * card no longer flips to "Checking connection…" and hides its Login button on every focus.
 */

import { useEffect, useRef, useState } from 'react';

import { type TokenState, msUntil, tokenState as tokenStateAt } from '../lib/market';
import { usePolledResource } from './usePolledResource';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FyersAuthStatus {
  configured: boolean;
  connected: boolean;
  degraded: boolean;
  needsReauth: boolean;
  /** Fyers rejected a token whose expiry date had not passed (revoked or reset early). */
  revoked?: boolean;
  expiresAt?: string;
  appId?: string;
}

export interface FyersAuthState {
  /** The last status the server returned; kept through refetches and failed polls. */
  status: FyersAuthStatus | null;
  /** True only until the first request settles. */
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** Where the token stands right now (re-evaluated as the clock moves). */
  tokenState: TokenState;
  /** Milliseconds until expiry (negative once past), or null when no expiry is known. */
  msLeft: number | null;
}

const STATUS_URL = '/api/auth/fyers/status';
const POLL_MS = 60_000;
/** How often the countdown and token state are re-derived from the clock. */
const CLOCK_TICK_MS = 30_000;

/**
 * The token state implied by a status response at `now`.
 *
 * `missing` covers every "there is no token this app can use" case: status not loaded, OAuth
 * not configured, no stored token, or one the server rejects for a reason other than its
 * expiry (minted for a different app id).
 */
export function fyersTokenState(status: FyersAuthStatus | null, now: Date): TokenState {
  if (!status || !status.configured) return 'missing';
  const byClock = tokenStateAt(status.expiresAt, now);
  if (byClock === 'missing' || byClock === 'expired') return byClock;
  if (status.needsReauth || !status.connected) return 'missing';
  return byClock;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFyersAuthStatus(): FyersAuthState {
  const { data, loading, error, refetch } = usePolledResource<FyersAuthStatus>(STATUS_URL, {
    intervalMs: POLL_MS,
  });

  // usePolledResource raises `loading` and clears `error` on every manual refetch. Latch the
  // first settle and hold the last settled error so neither flickers during a refetch.
  const settled = useRef(false);
  const lastError = useRef<string | null>(null);
  if (!loading) {
    settled.current = true;
    lastError.current = error;
  }

  useEffect(() => {
    // The user may have just completed Fyers OAuth in another tab and returned here.
    window.addEventListener('focus', refetch);
    return () => window.removeEventListener('focus', refetch);
  }, [refetch]);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // A fresh response is judged against a fresh clock, not one up to a tick old.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read the clock when data changes
  useEffect(() => setNow(new Date()), [data]);

  return {
    status: data,
    loading: !settled.current,
    error: loading ? lastError.current : error,
    refresh: refetch,
    tokenState: fyersTokenState(data, now),
    msLeft: msUntil(data?.expiresAt, now),
  };
}
