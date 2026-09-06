import { useEffect, useState } from 'react';

import { apiGet } from '../lib/api';

/** Shape of GET /api/meta. */
export interface Meta {
  simulate: boolean;
  broker: string;
  authDegraded: boolean;
}

export interface MetaState {
  meta: Meta | null;
  loading: boolean;
}

const POLL_MS = 30_000;

/**
 * Polls /api/meta for environment + broker-health status shown in the top bar
 * (SIM/LIVE badge, broker name, auth-degraded warning). Follows the same
 * AbortController + in-flight-guard polling convention as usePaperTrades; fails
 * quietly (meta stays null) so the shell renders even if the endpoint is down.
 */
export function useMeta(): MetaState {
  const [state, setState] = useState<MetaState>({ meta: null, loading: true });

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;

    async function poll(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      const result = await apiGet<Meta>('/api/meta', controller.signal);
      inFlight = false;
      if (!result.ok) {
        if (result.error === 'AbortError') return;
        setState((prev) => ({ meta: prev.meta, loading: false }));
        return;
      }
      setState({ meta: result.data, loading: false });
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  return state;
}
