/**
 * Shapes and small rules for the scheduler's loopback API (apps/scheduler/src/api.ts),
 * reached at `/api/scheduler/*` — which only resolves when the dashboard runs with
 * SCHEDULER_DIRECT=1 (the dev stack sets it). Kept free of React so it can be unit-tested.
 */

import type { Status } from '../components/ui/Badge';

export const SCHEDULER_API = '/api/scheduler';

export type JobNeed = 'home' | 'gui' | 'postgres';

export interface SchedulerRun {
  id: number;
  job: string;
  trigger: 'schedule' | 'catch-up' | 'manual';
  scheduled_for: string | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  attempts: number;
  error: string | null;
}

export interface SchedulerJob {
  id: string;
  description: string;
  /** Human label, e.g. "Mon-Fri 17:00 IST". */
  schedule: string;
  nextRun: string | null;
  lastRun: SchedulerRun | null;
  needs: JobNeed[];
  group: string | null;
}

export interface SchedulerLog {
  run: number;
  path: string;
  lines: number;
  text: string;
}

/** Where a run stands: still going, finished clean, or finished with a failure. */
export function runStatus(run: SchedulerRun | null): Status | null {
  if (!run) return null;
  if (run.ended_at === null) return 'running';
  return run.exit_code === 0 ? 'completed' : 'failed';
}

export const RUN_STATUS_LABEL: Partial<Record<Status, string>> = {
  running: 'Running',
  completed: 'Succeeded',
  failed: 'Failed',
};

/** Milliseconds a finished run took; null while running or when the stamps are unusable. */
export function runDurationMs(run: SchedulerRun | null): number | null {
  if (!run?.ended_at) return null;
  const ms = Date.parse(run.ended_at) - Date.parse(run.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** A job that needs the owner's laptop session (residential IP or a browser window). */
export function needsConfirmation(job: Pick<SchedulerJob, 'needs'>): boolean {
  return job.needs.includes('home') || job.needs.includes('gui');
}

/** A friendly sentence for a failed "Run now" (the API answers 409 busy, 404 unknown). */
export function runNowError(status: number | undefined, error: string): string {
  if (status === 409) return `Not started: ${error}. Try again when it finishes.`;
  if (status === 404) return 'The scheduler does not know that job (is it an older build?).';
  return `Could not start the run: ${error}`;
}
