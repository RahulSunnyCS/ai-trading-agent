import { usePolledResource } from './usePolledResource.js';

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
 * (SIM/LIVE badge, broker name, auth-degraded warning). Built on
 * usePolledResource; fails quietly (meta stays null) so the shell renders
 * even if the endpoint is down.
 */
export function useMeta(): MetaState {
  const { data, loading } = usePolledResource<Meta>('/api/meta', { intervalMs: POLL_MS });
  return { meta: data, loading };
}
