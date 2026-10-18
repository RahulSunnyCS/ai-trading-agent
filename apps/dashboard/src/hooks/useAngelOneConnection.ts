/**
 * useAngelOneConnection — the Angel One card's status (GET /api/backtest/legwise/angel/status,
 * on mount and every 60 s) and its Test connection action.
 *
 * POST …/angel/test answers at once (202 once the server's guard is passed; the login runs in
 * the background there, so a hosted dashboard never meets a gateway timeout). The hook then
 * re-reads the status every 2 s until it carries the check that test produced, and reports that
 * as `testResult`. A refusal (409 one already running, 429 cool-down or a hold after a refused
 * login) is `testError`. A second `test()` while one is in flight is ignored.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ANGEL_STATUS_URL,
  ANGEL_TEST_URL,
  type AngelCheck,
  type AngelStatus,
  type AngelTestStarted,
  resultOf,
} from '../lib/angelOne';
import { apiPost } from '../lib/api';
import { usePolledResource } from './usePolledResource';

const POLL_MS = 60_000;
/** How often the status is re-read while a started test has no result yet. */
export const RESULT_POLL_MS = 2_000;
/** Give up waiting after this long (a login with network retries takes at most ~100 s). */
const RESULT_TIMEOUT_MS = 180_000;

export interface AngelOneConnection {
  status: AngelStatus | null;
  /** True only until the first status settles. */
  loading: boolean;
  error: string | null;
  /** A test started here is running (from the click until its result lands). */
  testing: boolean;
  /** The check the last Test connection here ran (also recorded upstream). */
  testResult: AngelCheck | null;
  /** Why the last Test connection here did not run or gave no result. */
  testError: string | null;
  test: () => Promise<void>;
}

export function useAngelOneConnection(): AngelOneConnection {
  const { data, loading, error, refetch } = usePolledResource<AngelStatus>(ANGEL_STATUS_URL, {
    intervalMs: POLL_MS,
    cache: true,
  });

  const [testing, setTesting] = useState(false);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AngelCheck | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const finish = useCallback(() => {
    inFlight.current = false;
    setStartedAt(null);
    setTesting(false);
  }, []);

  const test = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setTesting(true);
    setTestError(null);
    const res = await apiPost<AngelTestStarted>(ANGEL_TEST_URL, {});
    if (res.ok) {
      setStartedAt(res.data.started_at);
    } else {
      setTestError(res.error);
      finish();
    }
    refetch();
  }, [finish, refetch]);

  // While a started test has no result, ask again every few seconds.
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(refetch, RESULT_POLL_MS);
    const giveUp = setTimeout(() => {
      setTestError('No result yet. It will show here once the check finishes.');
      finish();
    }, RESULT_TIMEOUT_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(giveUp);
    };
  }, [startedAt, refetch, finish]);

  // The status now carries the check this test produced.
  useEffect(() => {
    if (!startedAt) return;
    const result = resultOf(data, startedAt);
    if (result) {
      setTestResult(result);
      finish();
    }
  }, [data, startedAt, finish]);

  return {
    status: data,
    loading: loading && data === null,
    error,
    testing,
    testResult,
    testError,
    test,
  };
}
