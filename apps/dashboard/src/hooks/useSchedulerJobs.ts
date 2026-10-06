import { SCHEDULER_API, type SchedulerJob, type SchedulerLog } from '../lib/scheduler';
import { type PolledResourceResult, usePolledResource } from './usePolledResource';

/** Every job with its next run and latest run. Polled, so a manual run shows up as it goes. */
export function useSchedulerJobs(): PolledResourceResult<SchedulerJob[]> {
  return usePolledResource<SchedulerJob[]>(`${SCHEDULER_API}/jobs`, { intervalMs: 10_000 });
}

/** The tail of one run's log. Polls while the run is still going. */
export function useRunLog(runId: number, polling: boolean): PolledResourceResult<SchedulerLog> {
  return usePolledResource<SchedulerLog>(
    `${SCHEDULER_API}/runs/${runId}/log?tail=200`,
    polling ? { intervalMs: 3_000 } : {},
  );
}
