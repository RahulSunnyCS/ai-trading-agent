/**
 * useMomentumWeeklyJob — the latest manual weekly-signal run, which the Momentum
 * service executes in the background. Polls only while a run is in progress, so
 * the Weekly signal view (and the section tab's "running" dot) pick the result up
 * whenever the user comes back, without keeping the page open.
 */

import { useCallback, useState } from 'react';

import { apiPost } from '../lib/api';
import type { MomentumWeeklyJob } from '../types/momentum';
import { usePolledResource } from './usePolledResource';

const POLL_MS = 2000;

export interface MomentumWeeklyJobState {
  job: MomentumWeeklyJob | null;
  running: boolean;
  /** Starting failed before any job existed (e.g. service down). */
  startError: string | null;
  start: (run: MomentumWeeklyJob['run'], send: boolean) => Promise<void>;
}

export function useMomentumWeeklyJob(): MomentumWeeklyJobState {
  // Set from the trigger's response until the poll has caught up with that job, so the
  // view never flickers back to idle between "started" and the first poll.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const { data, refetch } = usePolledResource<{ job: MomentumWeeklyJob | null }>(
    '/api/momentum/weekly/jobs/latest',
    polling ? { intervalMs: POLL_MS } : {},
  );
  const job = data?.job ?? null;
  const caughtUp = pendingId === null || job?.id === pendingId;
  const running = starting || !caughtUp || job?.status === 'running';
  // Poll exactly while a run is in flight, including one started in another tab or
  // before a reload (React's "adjust state while rendering" pattern).
  if (polling !== running) setPolling(running);
  if (pendingId !== null && job?.id === pendingId) setPendingId(null);

  const start = useCallback(
    async (run: MomentumWeeklyJob['run'], send: boolean) => {
      setStarting(true);
      setStartError(null);
      const response = await apiPost<{ started: boolean; job: MomentumWeeklyJob }>(
        '/api/momentum/weekly/run',
        { run, send },
      );
      if (response.ok) setPendingId(response.data.job.id);
      else setStartError(response.error);
      setStarting(false);
      refetch();
    },
    [refetch],
  );

  return { job, running, startError, start };
}
