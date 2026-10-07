import { usePolledResource } from './usePolledResource';

/** Shape of GET /api/meta. */
export interface Meta {
  simulate: boolean;
  broker: string;
  authDegraded: boolean;
}

export interface MetaState {
  /** The last successful response; kept while a later poll fails. */
  meta: Meta | null;
  loading: boolean;
  /** Why the most recent request failed, or null when it succeeded (or none has settled). */
  error: string | null;
}

const POLL_MS = 30_000;

/**
 * Polls /api/meta for environment + broker-health status shown in the top bar
 * (SIM/LIVE badge, broker name, auth-degraded warning). Built on
 * usePolledResource; a failure never throws (meta stays at its last value, or
 * null) so the shell renders even if the endpoint is down, and `error` says
 * whether the last poll reached the API.
 */
export function useMeta(): MetaState {
  // `cache`: mounted in several places at once, so a later mount starts from the last answer.
  const { data, loading, error } = usePolledResource<Meta>('/api/meta', {
    intervalMs: POLL_MS,
    cache: true,
  });
  return { meta: data, loading, error };
}
