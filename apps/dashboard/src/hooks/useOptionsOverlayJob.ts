/**
 * useOptionsOverlayJob — one Options overlay run (BL-227), executed by the Momentum service in
 * the background (a favourite's re-run on F&O stocks takes a minute or two cold). Starts a job,
 * then polls it only while it runs; the last finished result stays on screen.
 */

import { useCallback, useState } from 'react';

import { apiPost } from '../lib/api';
import { jobRunning } from '../lib/optionsOverlay';
import type { OverlayJob, OverlayRequest } from '../types/optionsOverlay';
import { usePolledResource } from './usePolledResource';

const POLL_MS = 2000;
export const OVERLAY_JOBS_URL = '/api/momentum/options-overlay/jobs';

export interface OptionsOverlayJobState {
  job: OverlayJob | null;
  running: boolean;
  error: string | null;
  start: (request: OverlayRequest) => Promise<void>;
}

export function useOptionsOverlayJob(): OptionsOverlayJobState {
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const { data, error } = usePolledResource<OverlayJob>(
    jobId ? `${OVERLAY_JOBS_URL}/${jobId}` : `${OVERLAY_JOBS_URL}/none`,
    { enabled: jobId !== null, ...(polling ? { intervalMs: POLL_MS } : {}) },
  );
  const job = data && data.id === jobId ? data : null;
  // a poll error ends the wait (the service restarted and forgot the job: every poll is a 404)
  const running = jobRunning({ starting, jobId, job, pollError: error });
  if (polling !== running) setPolling(running);

  const start = useCallback(async (request: OverlayRequest) => {
    setStarting(true);
    setStartError(null);
    const response = await apiPost<OverlayJob>(OVERLAY_JOBS_URL, request);
    if (response.ok) setJobId(response.data.id);
    else setStartError(response.error);
    setStarting(false);
  }, []);

  return {
    job,
    running,
    error: startError ?? (job?.status === 'failed' ? job.error : null) ?? (jobId ? error : null),
    start,
  };
}
