import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from './jobs.js';
import { istDay } from './schedule.js';

/**
 * BL-143 Phase 4: while today is held by the stop button, these jobs are paused (each slot is
 * recorded as held, never run): every job that could upload, deploy or enable anything. The
 * Quantiply switch-off (`quantiply-disable`) and the read-only checks still run.
 *
 * The hold is a file written by the stop runner, `TRADING_DATA_ROOT/stop/hold-<IST day>.json`:
 * the same path as `packages/broker-login/src/stop-hold.ts` (`holdPath`), whose deployers and
 * uploaders also refuse to change anything while it exists. Both packages' tests pin the path.
 */
export const STOP_HELD_JOBS: readonly string[] = [
  'algotest-evening',
  'algotest-topup',
  'algotest-deploy',
  'quantiply-evening',
  'quantiply-topup',
  'quantiply-deploy',
  'quantiply-deploy-topup',
];

export function holdFile(dataRoot: string, day: string): string {
  return join(dataRoot, 'stop', `hold-${day}.json`);
}

/**
 * Is today held? The file, or a stop this process confirmed today (`mark`), so a hold that could
 * not be written (an unmounted data volume) still pauses the jobs until the scheduler restarts.
 */
export class StopHold {
  private readonly days = new Set<string>();

  constructor(private readonly env: Record<string, string>) {}

  mark(day: string): void {
    this.days.add(day);
  }

  held(now: Date): boolean {
    const day = istDay(now);
    if (this.days.has(day)) return true;
    const root = this.env.TRADING_DATA_ROOT?.trim();
    return Boolean(root && existsSync(holdFile(root, day)));
  }

  /** The loop's question: is this job paused right now? */
  pauses(job: Job, now: Date): boolean {
    return STOP_HELD_JOBS.includes(job.id) && this.held(now);
  }
}
