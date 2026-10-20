import { existsSync, readFileSync, rmSync } from 'node:fs';
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { settingsPath } from './automation-settings.js';
import { redact } from './secrets.js';
import { istToday } from './strategy-plan.js';

/**
 * BL-143 Phase 4: the stop button's hold marker and log.
 *
 * The hold is written by a confirmed stop before it changes anything, in two places, and either
 * one holds:
 * - `TRADING_DATA_ROOT/stop/HOLD.json`, beside the ledgers (the record);
 * - `<scheduler state dir>/stop-hold.json` (`SCHEDULER_STATE_DIR`, the laptop's own disk), so an
 *   unmounted data volume does not lose it.
 * If neither can be written the stop still squares off and switches off (squaring off is the
 * point of the button; coordinator's decision 2026-10-20), says "HOLD NOT SAVED" first in its
 * report, and the scheduler keeps the hold in memory until it restarts.
 *
 * It holds until the owner lifts it (Telegram's Resume with its confirm tap, or
 * `stop-button.ts --clear-hold`), across days. While it holds, the AlgoTest deployer
 * (`strategy-deploy.ts`), both uploaders (`strategy-upload.ts`, `quantiply-upload.ts`) and the
 * Quantiply enabler (`quantiply-deploy.ts --mode enable`) change nothing with `--apply`, and the
 * scheduler refuses their jobs (`apps/scheduler/src/stop-hold.ts`, the same two paths; both
 * packages' tests pin them). The disable safety net is never held.
 *
 * `<IST day>.jsonl` under `TRADING_DATA_ROOT/stop/`: every step of a stop or a resume, one JSON
 * line each. Never a token or a password.
 */

export function stopDir(dataRoot: string): string {
  return join(dataRoot, 'stop');
}

export function holdPath(dataRoot: string): string {
  return join(stopDir(dataRoot), 'HOLD.json');
}

/** The second copy, on the scheduler's state dir (beside `automation-settings.json`). */
export function stateHoldPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(settingsPath(env)), 'stop-hold.json');
}

export function stopLogPath(dataRoot: string, day: string): string {
  return join(stopDir(dataRoot), `${day}.jsonl`);
}

export interface Hold {
  at: string;
  by: string;
  path: string;
}

function readOne(path: string): Hold | null {
  if (!existsSync(path)) return null;
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as Partial<Hold>;
    return { at: String(h.at ?? '?'), by: String(h.by ?? '?'), path };
  } catch {
    return { at: '?', by: 'unreadable hold file', path }; // it exists: never fail open
  }
}

/** The hold from either place, or null. */
export function readHold(
  dataRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Hold | null {
  return (dataRoot ? readOne(holdPath(dataRoot)) : null) ?? readOne(stateHoldPath(env));
}

async function writeOne(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, 'utf8');
  if (!readOne(path)) throw new Error(`${path} is not readable after writing it`);
}

export interface HoldWrite {
  /** where it was saved (empty: nowhere) */
  saved: string[];
  /** why each place failed */
  failed: string[];
}

/** Writes the hold to both places, each read back. Never throws: the result says what held. */
export async function writeHold(
  dataRoot: string | undefined,
  by: string,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<HoldWrite> {
  // an existing hold keeps its first time: the owner sees since when nothing has been deployed
  const since = readHold(dataRoot, env)?.at;
  const body = `${JSON.stringify({ at: since ?? now.toISOString(), by })}\n`;
  const out: HoldWrite = { saved: [], failed: [] };
  const places = [...(dataRoot ? [holdPath(dataRoot)] : []), stateHoldPath(env)];
  if (!dataRoot) out.failed.push('TRADING_DATA_ROOT is not set');
  for (const path of places) {
    try {
      await writeOne(path, body);
      out.saved.push(path);
    } catch (error) {
      out.failed.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
}

/** Lifts the hold in both places; each file is kept, renamed, as a record. False: none. */
export async function clearHold(
  dataRoot: string | undefined,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let any = false;
  for (const path of [...(dataRoot ? [holdPath(dataRoot)] : []), stateHoldPath(env)]) {
    if (!existsSync(path)) continue;
    await rename(path, path.replace(/\.json$/, `-cleared-${stamp}.json`));
    any = true;
  }
  return any;
}

/**
 * While a stop runs: `stop-running.json` (`{pid, at}`) beside each hold copy
 * (`TRADING_DATA_ROOT/stop/stop-running.json`, and `<SCHEDULER_STATE_DIR>/stop-running.json`),
 * removed when the stop ends (also on SIGTERM / SIGINT), so other jobs that log in (the loss /
 * deploy monitor, BL-143 #276) keep off the accounts meanwhile, and a second stop does not start.
 * A marker is stale, and ignored, when its pid is dead or this process's, when it is older than
 * `STOP_RUNNING_STALE_MS` (the runner's 15-minute timeout plus a margin) or not from today (IST),
 * whatever its pid: a pid is soon reused after a crash or a reboot.
 */
export function stopRunningPaths(
  dataRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...(dataRoot ? [join(stopDir(dataRoot), 'stop-running.json')] : []),
    join(dirname(settingsPath(env)), 'stop-running.json'),
  ];
}

export const STOP_RUNNING_STALE_MS = 20 * 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface RunningStop {
  pid: number;
  /** IST `YYYY-MM-DD HH:MM` */
  since: string;
  path: string;
}

/** The marker at `path` if it is a live, fresh stop other than this process, else null. */
function liveMarker(path: string, now: Date): RunningStop | null {
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; at?: unknown };
    if (typeof m.pid !== 'number' || m.pid === process.pid) return null;
    const at = typeof m.at === 'string' ? Date.parse(m.at) : Number.NaN;
    if (Number.isNaN(at)) return null;
    if (now.getTime() - at > STOP_RUNNING_STALE_MS) return null;
    if (istToday(new Date(at)) !== istToday(now)) return null;
    if (!pidAlive(m.pid)) return null;
    const ist = new Date(at + 330 * 60_000).toISOString();
    return { pid: m.pid, since: `${ist.slice(0, 10)} ${ist.slice(11, 16)}`, path };
  } catch {
    return null; // torn or unreadable: no pid to trust, not a running stop
  }
}

/** Another stop that is running now (a live, fresh marker that is not this one), or null. */
export function otherStopRunning(
  dataRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): RunningStop | null {
  for (const path of stopRunningPaths(dataRoot, env)) {
    const live = liveMarker(path, now);
    if (live) return live;
  }
  return null;
}

export interface StopMark {
  /** another stop holds a marker: this one must not run */
  conflict: RunningStop | null;
  release: () => Promise<void>;
  /** for a signal handler: removes this run's markers synchronously */
  releaseSync: () => void;
}

/**
 * Takes the marker in every place it can, each with an exclusive create (`wx`): a stale marker is
 * replaced; a live one of another stop is a `conflict` (and this run marks nothing).
 */
export async function markStopRunning(
  dataRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<StopMark> {
  const written: string[] = [];
  const body = `${JSON.stringify({ pid: process.pid, at: now.toISOString() })}\n`;
  const releaseSync = () => {
    for (const path of written) {
      try {
        if (readFileSync(path, 'utf8') === body) rmSync(path, { force: true });
      } catch {
        // already gone
      }
    }
  };
  const release = async () => releaseSync();
  for (const path of stopRunningPaths(dataRoot, env)) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, body, { encoding: 'utf8', flag: 'wx' });
        written.push(path);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') break; // best effort
        const live = liveMarker(path, now);
        if (live) {
          releaseSync();
          return { conflict: live, release: async () => undefined, releaseSync: () => undefined };
        }
        await rm(path, { force: true }).catch(() => undefined); // stale: replaced
      }
    }
  }
  return { conflict: null, release, releaseSync };
}

/**
 * The second copy of the stop's square-off rows, on the scheduler's state dir: a second press
 * still knows what the first sent when the data volume is unmounted (`priorSquareOffs`).
 */
export function stateSquareOffLogPath(day: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(settingsPath(env)), `stop-squareoffs-${day}.jsonl`);
}

/** For the deployers and uploaders: why an `--apply` run must change nothing, or null. */
export function stopHeld(env: NodeJS.ProcessEnv = process.env): string | null {
  const hold = readHold(env.TRADING_DATA_ROOT?.trim() || undefined, env);
  if (!hold) return null;
  return `held by the stop button since ${hold.at} (${hold.path}): nothing changed. Lift it with Resume in Telegram, or: cd packages/broker-login && node_modules/.bin/tsx src/stop-button.ts --clear-hold`;
}

/** One line of the stop log. Never throws: the log must not be what stops a stop. */
export async function appendStopLog(
  dataRoot: string,
  row: Record<string, unknown>,
  now: Date = new Date(),
): Promise<void> {
  try {
    await mkdir(stopDir(dataRoot), { recursive: true });
    const line = redact(JSON.stringify({ at: now.toISOString(), ...row }));
    await appendFile(stopLogPath(dataRoot, istToday(now)), `${line}\n`, 'utf8');
  } catch (error) {
    console.error(
      `stop log not written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
