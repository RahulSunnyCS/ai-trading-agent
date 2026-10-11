/**
 * usePolledResource for a read that can answer "still working" (BL-095). The portfolio-stop
 * routes replay hundreds of strategy-days the first time; the API answers `202 {"status":
 * "warming"}` within its wait instead of holding the request past the proxy's timeout, and the
 * work carries on server side. This hook shows that as `warming: true` (data stays null) and asks
 * again every few seconds until the real answer arrives.
 */

import { useEffect, useState } from 'react';

import { type PolledResourceResult, usePolledResource } from './usePolledResource';

export interface WarmingBody {
  status: 'warming';
}

export const WARMING_RETRY_MS = 4000;

export function isWarming(value: unknown): value is WarmingBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { status?: unknown }).status === 'warming'
  );
}

export interface WarmingResourceResult<T> extends PolledResourceResult<T> {
  /** The server accepted the request and is still computing it. */
  warming: boolean;
}

export function useWarmingResource<T>(
  url: string,
  opts: {
    enabled?: boolean;
    /** A 200 answer that is complete enough to show but still has a part being computed: its
     * data is kept and `warming` is true until a later answer says otherwise. */
    pending?: (data: T) => boolean;
  } = {},
): WarmingResourceResult<T> {
  const [retryMs, setRetryMs] = useState<number | undefined>(undefined);
  const res = usePolledResource<T | WarmingBody>(url, {
    ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
    ...(retryMs === undefined ? {} : { intervalMs: retryMs }),
  });
  const bare = isWarming(res.data);
  const warming = bare || (res.data !== null && opts.pending?.(res.data as T) === true);
  useEffect(() => {
    setRetryMs(warming ? WARMING_RETRY_MS : undefined);
  }, [warming]);
  return {
    data: bare ? null : (res.data as T | null),
    loading: res.loading || warming,
    error: res.error,
    refetch: res.refetch,
    warming,
  };
}
