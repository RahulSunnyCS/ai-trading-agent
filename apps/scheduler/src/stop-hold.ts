import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * BL-143 Phase 4: while the stop button's hold is on, these jobs never run (every path: the
 * schedule, a catch-up, `jobs run`, the dashboard's Apply now, a job queued behind its group):
 * `runJob` records the run as held instead. They are every job that could upload, deploy or
 * enable anything. The Quantiply switch-off (`quantiply-disable`) and the read-only checks still
 * run.
 *
 * The hold lasts until the owner lifts it (Telegram's Resume, or `stop-button.ts --clear-hold`).
 * It is on while any of these holds:
 * - `TRADING_DATA_ROOT/stop/HOLD.json` (the stop runner's record),
 * - `<SCHEDULER_STATE_DIR>/stop-hold.json` (its copy on the laptop's own disk),
 *   both the same paths as `packages/broker-login/src/stop-hold.ts`; both packages' tests pin them;
 * - this process's memory: a stop confirmed here holds even when neither file could be written
 *   (the stop still squares off; coordinator's decision 2026-10-20). Memory covers this process
 *   only (the loop, Apply now) and ends with it; `jobs run` in another process sees the files.
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

/** Beside `automation-settings.json`, in the scheduler's state dir. */
export function stateHoldFile(env: Record<string, string>): string {
  const dir =
    env.SCHEDULER_STATE_DIR?.trim() ||
    join(homedir(), 'Library', 'Application Support', 'ai-trading-agent');
  return join(dir, 'stop-hold.json');
}

export interface HoldInfo {
  at: string;
  by: string;
}

let memory: HoldInfo | null = null;

/** A stop was confirmed in this process: hold, whatever the files say, until Resume. */
export function holdInMemory(by: string, at: Date = new Date()): void {
  memory ??= { at: at.toISOString(), by: `${by} (in memory only until a file holds)` };
}

export function clearMemoryHold(): void {
  memory = null;
}

function readOne(path: string): HoldInfo | null {
  if (!existsSync(path)) return null;
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as Partial<HoldInfo>;
    return { at: String(h.at ?? '?'), by: String(h.by ?? '?') };
  } catch {
    return { at: '?', by: 'unreadable hold file' }; // it exists: never fail open
  }
}

/** The hold from either file or this process's memory, or null. */
export function readHold(env: Record<string, string>): HoldInfo | null {
  const root = env.TRADING_DATA_ROOT?.trim();
  return (root ? readOne(holdFile(root)) : null) ?? readOne(stateHoldFile(env)) ?? memory;
}

/** Why this job must not run now, or null. */
export function heldReason(jobId: string, env: Record<string, string>): string | null {
  if (!STOP_HELD_JOBS.includes(jobId)) return null;
  const hold = readHold(env);
  return hold
    ? `held: the stop button's hold is on (since ${hold.at}); nothing is uploaded, enabled or deployed until it is lifted (Resume in Telegram)`
    : null;
}
