import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * BL-143 Phase 4: while the stop button's hold is on, these jobs never run (every path: the
 * schedule, a catch-up, `jobs run`, the dashboard's Apply now, a job queued behind its group):
 * `runJob` records the run as held instead. They are every job that could upload, deploy or
 * enable anything. The Quantiply switch-off (`quantiply-disable`) and the read-only checks still
 * run.
 *
 * The hold is a file the stop runner writes before it does anything else, and it lasts until the
 * owner lifts it (Telegram's Resume, or `stop-button.ts --clear-hold`):
 * `TRADING_DATA_ROOT/stop/HOLD.json`, the same path as `packages/broker-login/src/stop-hold.ts`
 * (`holdPath`), whose deployers and uploaders also refuse to change anything while it exists.
 * Both packages' tests pin the path. A stop that cannot write it does nothing (fail closed).
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

export function holdFile(dataRoot: string): string {
  return join(dataRoot, 'stop', 'HOLD.json');
}

export interface HoldInfo {
  at: string;
  by: string;
}

/** The hold, or null. An unreadable file still holds: never fail open. */
export function readHold(env: Record<string, string>): HoldInfo | null {
  const root = env.TRADING_DATA_ROOT?.trim();
  if (!root) return null;
  const path = holdFile(root);
  if (!existsSync(path)) return null;
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as Partial<HoldInfo>;
    return { at: String(h.at ?? '?'), by: String(h.by ?? '?') };
  } catch {
    return { at: '?', by: 'unreadable hold file' };
  }
}

/** Why this job must not run now, or null. */
export function heldReason(jobId: string, env: Record<string, string>): string | null {
  if (!STOP_HELD_JOBS.includes(jobId)) return null;
  const hold = readHold(env);
  return hold
    ? `held: the stop button's hold is on (since ${hold.at}); nothing is uploaded, enabled or deployed until it is lifted (Resume in Telegram)`
    : null;
}
