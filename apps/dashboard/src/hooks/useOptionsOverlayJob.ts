/**
 * useOptionsOverlayJob — one Options overlay run (BL-227), executed by the Momentum service in
 * the background (a favourite's re-run on F&O stocks takes a minute or two cold). Starts a job,
 * then polls it only while it runs; the last finished result stays on screen. The same hook runs
 * the Fresh starts card's jobs (`OVERLAY_STARTS_JOBS_URL`).
 */

import { useCallback, useState } from 'react';

import { apiPost } from '../lib/api';
import { jobRunning } from '../lib/optionsOverlay';
import type { OverlayJob, OverlayRequest, OverlayResult } from '../types/optionsOverlay';
import { usePolledResource } from './usePolledResource';

const POLL_MS = 2000;
export const OVERLAY_JOBS_URL = '/api/momentum/options-overlay/jobs';
export const OVERLAY_STARTS_JOBS_URL = '/api/momentum/options-overlay/starts/jobs';

export interface OptionsOverlayJobState<R, Q> {
  job: OverlayJob<R> | null;
  running: boolean;
  error: string | null;
  start: (request: Q) => Promise<void>;
}

export function useOptionsOverlayJob<R = OverlayResult, Q = OverlayRequest>(
  url: string = OVERLAY_JOBS_URL,
): OptionsOverlayJobState<R, Q> {
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const { data, error } = usePolledResource<OverlayJob<R>>(
    jobId ? `${url}/${jobId}` : `${url}/none`,
    { enabled: jobId !== null, ...(polling ? { intervalMs: POLL_MS } : {}) },
  );
  const job = data && data.id === jobId ? data : null;
  // a poll error ends the wait (the service restarted and forgot the job: every poll is a 404)
  const running = jobRunning({ starting, jobId, job, pollError: error });
  if (polling !== running) setPolling(running);

  const start = useCallback(
    async (request: Q) => {
      setStarting(true);
      setStartError(null);
      const response = await apiPost<OverlayJob<R>>(url, request);
      if (response.ok) setJobId(response.data.id);
      else setStartError(response.error);
      setStarting(false);
    },
    [url],
  );

  return {
    job,
    running,
    error: startError ?? (job?.status === 'failed' ? job.error : null) ?? (jobId ? error : null),
    start,
  };
}
