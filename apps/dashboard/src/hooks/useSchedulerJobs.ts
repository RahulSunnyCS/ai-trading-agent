import { SCHEDULER_API, type SchedulerJob, type SchedulerLog } from '../lib/scheduler';
import { type PolledResourceResult, usePolledResource } from './usePolledResource';

/** Every job with its next run and latest run. Polled, so a manual run shows up as it goes. */
export function useSchedulerJobs(): PolledResourceResult<SchedulerJob[]> {
  return usePolledResource<SchedulerJob[]>(`${SCHEDULER_API}/jobs`, { intervalMs: 10_000 });
}

/**
 * The tail of one run's log. Polls while the run is still going; `enabled: false` fetches nothing
 * (the Overview reads a failed run's log only when its error says nothing). Cached per run, so the
 * Overview and the Jobs page share one read.
 */
export function useRunLog(
  runId: number,
  polling: boolean,
  enabled = true,
): PolledResourceResult<SchedulerLog> {
  return usePolledResource<SchedulerLog>(`${SCHEDULER_API}/runs/${runId}/log?tail=200`, {
    cache: true,
    enabled,
    ...(polling ? { intervalMs: 3_000 } : {}),
  });
}
