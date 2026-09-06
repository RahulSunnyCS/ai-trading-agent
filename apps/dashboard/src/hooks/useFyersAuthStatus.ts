/**
 * useFyersAuthStatus — polls GET /api/auth/fyers/status on mount and whenever
 * the window regains focus.
 *
 * The focus-refetch pattern is intentional: after the user completes the Fyers
 * OAuth login in a new tab and switches back, the status refreshes automatically
 * without requiring a manual button press.
 */

import { useCallback, useEffect, useState } from 'react';

import { apiGet } from '../lib/api.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FyersAuthStatus {
  configured: boolean;
  connected: boolean;
  degraded: boolean;
  needsReauth: boolean;
  expiresAt?: string;
  appId?: string;
}

export interface FyersAuthState {
  status: FyersAuthStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFyersAuthStatus(): FyersAuthState {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<FyersAuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await apiGet<FyersAuthStatus>('/api/auth/fyers/status');
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setStatus(result.data);
  }, []);

  useEffect(() => {
    void refresh();
    // Re-poll when the window regains focus: the user may have just completed
    // Fyers OAuth in another tab and returned here.
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return { status, loading, error, refresh };
}
