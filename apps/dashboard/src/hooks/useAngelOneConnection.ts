/**
 * useAngelOneConnection — the Angel One card's status (GET /api/backtest/legwise/angel/status,
 * on mount and every 60 s) and its Test connection action (POST …/angel/test: ONE SmartAPI
 * login upstream, guarded there: one at a time and a 60 s cool-down shared with the 08:00 job).
 *
 * `test()` ignores a second call while one is in flight; after it settles the status is
 * re-read, so the card's last check, the cool-down and "running" come from the server.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ANGEL_STATUS_URL,
  ANGEL_TEST_URL,
  type AngelCheck,
  type AngelStatus,
  type AngelTestResponse,
} from '../lib/angelOne';
import { apiPost } from '../lib/api';
import { usePolledResource } from './usePolledResource';

const POLL_MS = 60_000;

export interface AngelOneConnection {
  status: AngelStatus | null;
  /** True only until the first status settles. */
  loading: boolean;
  error: string | null;
  /** When the last status arrived (epoch ms), the base for its `retry_after_s`. */
  receivedAt: number;
  testing: boolean;
  /** The check the last Test connection here ran (also recorded upstream). */
  testResult: AngelCheck | null;
  /** Why the last Test connection here did not run (cool-down, one already running, offline). */
  testError: string | null;
  test: () => Promise<void>;
}

export function useAngelOneConnection(): AngelOneConnection {
  const { data, loading, error, refetch } = usePolledResource<AngelStatus>(ANGEL_STATUS_URL, {
    intervalMs: POLL_MS,
    cache: true,
  });

  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-stamp when a status arrives
  useEffect(() => setReceivedAt(Date.now()), [data]);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AngelCheck | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const test = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setTesting(true);
    setTestError(null);
    try {
      const res = await apiPost<AngelTestResponse>(ANGEL_TEST_URL, {});
      if (res.ok) setTestResult(res.data.result);
      else setTestError(res.error);
    } finally {
      inFlight.current = false;
      setTesting(false);
      refetch();
    }
  }, [refetch]);

  return {
    status: data,
    loading: loading && data === null,
    error,
    receivedAt,
    testing,
    testResult,
    testError,
    test,
  };
}
