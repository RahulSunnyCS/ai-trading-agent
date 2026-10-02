/**
 * useMomentumBackgroundJob — generic poll-while-running hook for the Momentum service's
 * single-flight background jobs (the weekly signal run, the stock-data sync). Polls only
 * while a job is in progress, so a section tab's "running" indicator and the view that
 * started it both pick the result up whenever the user comes back, without keeping the
 * page open. See useMomentumWeeklyJob.ts for the weekly-run-specific wrapper.
 */

import { useCallback, useState } from 'react';

import { apiPost } from '../lib/api';
import { usePolledResource } from './usePolledResource';

const POLL_MS = 2000;

interface BackgroundJob {
  id: string;
  status: 'running' | 'done' | 'failed';
}

export interface MomentumBackgroundJobState<TJob extends BackgroundJob> {
  job: TJob | null;
  running: boolean;
  /** Starting failed before any job existed (e.g. service down). */
  startError: string | null;
  start: () => Promise<void>;
}

export function useMomentumBackgroundJob<TJob extends BackgroundJob>(
  latestUrl: string,
  triggerUrl: string,
): MomentumBackgroundJobState<TJob> {
  // Set from the trigger's response until the poll has caught up with that job, so the
  // view never flickers back to idle between "started" and the first poll.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const { data, refetch } = usePolledResource<{ job: TJob | null }>(
    latestUrl,
    polling ? { intervalMs: POLL_MS } : {},
  );
  const job = data?.job ?? null;
  const caughtUp = pendingId === null || job?.id === pendingId;
  const running = starting || !caughtUp || job?.status === 'running';
  // Poll exactly while a job is in flight, including one started in another tab or
  // before a reload (React's "adjust state while rendering" pattern).
  if (polling !== running) setPolling(running);
  if (pendingId !== null && job?.id === pendingId) setPendingId(null);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    const response = await apiPost<{ started: boolean; job: TJob }>(triggerUrl, {});
    if (response.ok) setPendingId(response.data.job.id);
    else setStartError(response.error);
    setStarting(false);
    refetch();
  }, [refetch, triggerUrl]);

  return { job, running, startError, start };
}
