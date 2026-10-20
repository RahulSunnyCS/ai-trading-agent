import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { type AlgotestCredentials, algotestLogin } from './algotest.js';

/**
 * BL-143: one AlgoTest website login at a time, across processes on this laptop. The uploader,
 * the deployer and the trade monitor take this lock around their login (only the login, not the
 * work after it). Quantiply's logins have their own per-account lock in `quantiply-session.ts`
 * (`takeLoginLock`, shared with the stop button). The same file primitive (`tryLock`) also keeps
 * a second trade monitor from starting.
 *
 * The lock is a file created with O_EXCL holding the holder's pid; a holder whose process is
 * gone, or that is older than `staleMs` (a login takes well under that), is taken over.
 */

export type LoginPlatform = 'algotest';

/** `TRADING_DATA_ROOT/locks`, else the scheduler's state folder's (every job has one of them). */
export function lockDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.TRADING_DATA_ROOT?.trim();
  if (root) return join(root, 'locks');
  const state =
    env.SCHEDULER_STATE_DIR?.trim() ||
    join(homedir(), 'Library', 'Application Support', 'ai-trading-agent');
  return join(state, 'locks');
}

export interface Holder {
  pid: number;
  at: string;
  who: string;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Is this holder gone (process ended, or the file older than `staleMs`)? An unreadable file is. */
export function isStale(
  holder: Holder | null,
  now: number,
  staleMs: number,
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  if (!holder || !Number.isInteger(holder.pid)) return true;
  const at = Date.parse(holder.at);
  if (Number.isNaN(at) || now - at > staleMs) return true;
  return !alive(holder.pid);
}

function readHolder(path: string): Holder | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Holder;
  } catch {
    return null;
  }
}

/** Create the lock file if free (or stale); true when this process now holds it. */
export function tryLock(path: string, who: string, staleMs: number): boolean {
  for (let i = 0; i < 2; i += 1) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), who }), {
        flag: 'wx',
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!isStale(readHolder(path), Date.now(), staleMs)) return false;
      try {
        unlinkSync(path);
      } catch {
        // another process took it over first: try once more
      }
    }
  }
  return false;
}

/** Remove the lock only if this process still holds it. */
export function unlock(path: string): void {
  if (readHolder(path)?.pid === process.pid) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
}

export class LockBusy extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` holding the platform's login lock; waits up to `waitMs` for another login to end. */
export async function withLoginLock<T>(
  platform: LoginPlatform,
  who: string,
  fn: () => Promise<T>,
  opts: {
    dir?: string;
    waitMs?: number;
    staleMs?: number;
    /** false = `fn` never got as far as a login (it refused inside the lock): no stamp */
    stampIf?: () => boolean;
  } = {},
): Promise<T> {
  const dir = opts.dir ?? lockDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `login-${platform}.lock`);
  const staleMs = opts.staleMs ?? 10 * 60_000;
  const until = Date.now() + (opts.waitMs ?? 6 * 60_000);
  while (!tryLock(path, who, staleMs)) {
    if (Date.now() > until) {
      const h = readHolder(path);
      throw new LockBusy(
        `${platform}: another login holds the lock (${h?.who ?? '?'}, pid ${h?.pid ?? '?'}, since ${h?.at ?? '?'})`,
      );
    }
    await sleep(Math.max(10, Math.min(2_000, until - Date.now())));
  }
  try {
    return await fn();
  } finally {
    // When this platform was last logged in to, by whom (re-review of #276, B): the monitor does
    // not replace a lost session while another process's login is this recent. A caller that
    // refused inside the lock writes none, so it never hides another process's stamp.
    if (!opts.stampIf || opts.stampIf()) {
      try {
        writeFileSync(
          lastLoginPath(dir, platform),
          `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), who })}\n`,
        );
      } catch {
        // a missing stamp only means the monitor cannot see this login
      }
    }
    unlock(path);
  }
}

function lastLoginPath(dir: string, platform: LoginPlatform): string {
  return join(dir, `login-${platform}.last`);
}

/**
 * When the last login under this platform's lock ended, ms; null when unknown or when it was
 * `exceptPid`'s (the asking process's own).
 */
export function lastLoginAt(
  platform: LoginPlatform,
  dir: string = lockDir(),
  exceptPid?: number,
): number | null {
  const last = readHolder(lastLoginPath(dir, platform));
  if (exceptPid !== undefined && last?.pid === exceptPid) return null;
  const at = last?.at;
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** The AlgoTest website login under the lock (the uploader, the deployer, the monitor). */
export async function algotestLoginLocked(
  page: Page,
  credentials: AlgotestCredentials,
  who: string,
): Promise<void> {
  await withLoginLock('algotest', who, () => algotestLogin(page, credentials));
}
