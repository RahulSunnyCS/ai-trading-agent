import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from './secrets.js';
import { istToday } from './strategy-plan.js';

/**
 * BL-143 Phase 4: the stop button's hold marker and log, under `TRADING_DATA_ROOT/stop/`.
 *
 * - `HOLD.json`: written FIRST by a confirmed stop (a stop that cannot write it does nothing else
 *   and says so). It holds until the owner clears it (owner's decision via the coordinator,
 *   2026-10-20: persistent across days): `stop-button.ts --clear-hold`, or Telegram's Resume
 *   button with its confirm tap. While it exists the AlgoTest deployer (`strategy-deploy.ts`),
 *   both uploaders (`strategy-upload.ts`, `quantiply-upload.ts`) and the Quantiply enabler
 *   (`quantiply-deploy.ts --mode enable`) change nothing with `--apply`, and the scheduler
 *   refuses to run their jobs (`apps/scheduler/src/stop-hold.ts`, the same path; both packages'
 *   tests pin it). The disable safety net is never held.
 * - `<IST day>.jsonl`: every step of a stop or a resume, from the listener (the taps) and the
 *   runner (each call and its answer), one JSON line each. Never a token or a password.
 */

export function stopDir(dataRoot: string): string {
  return join(dataRoot, 'stop');
}

export function holdPath(dataRoot: string): string {
  return join(stopDir(dataRoot), 'HOLD.json');
}

export function stopLogPath(dataRoot: string, day: string): string {
  return join(stopDir(dataRoot), `${day}.jsonl`);
}

export interface Hold {
  at: string;
  by: string;
}

/** The hold, or null. An unreadable file still holds (it exists): never fail open. */
export function readHold(dataRoot: string): Hold | null {
  const path = holdPath(dataRoot);
  if (!existsSync(path)) return null;
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as Partial<Hold>;
    return { at: String(h.at ?? '?'), by: String(h.by ?? '?') };
  } catch {
    return { at: '?', by: 'unreadable hold file' };
  }
}

/** Writes the hold, then reads it back: throws unless it is really there. */
export async function writeHold(
  dataRoot: string,
  by: string,
  now: Date = new Date(),
): Promise<string> {
  await mkdir(stopDir(dataRoot), { recursive: true });
  const path = holdPath(dataRoot);
  // an existing hold keeps its first time: the owner sees since when nothing has been deployed
  const since = readHold(dataRoot)?.at;
  await writeFile(path, `${JSON.stringify({ at: since ?? now.toISOString(), by })}\n`, 'utf8');
  if (!readHold(dataRoot)) throw new Error(`${path} is not readable after writing it`);
  return path;
}

/** Lifts the hold; the file is kept, renamed, as a record. False when there was none. */
export async function clearHold(dataRoot: string, now: Date = new Date()): Promise<boolean> {
  const path = holdPath(dataRoot);
  if (!existsSync(path)) return false;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  await rename(path, join(stopDir(dataRoot), `HOLD-cleared-${stamp}.json`));
  return true;
}

/**
 * For the deployers and uploaders: why an `--apply` run must change nothing, or null. Reads
 * `TRADING_DATA_ROOT` from the environment; without it there is no hold to find.
 */
export function stopHeld(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.TRADING_DATA_ROOT?.trim();
  if (!root) return null;
  const hold = readHold(root);
  if (!hold) return null;
  return `held by the stop button since ${hold.at} (${holdPath(root)}): nothing changed. Lift it with Resume in Telegram, or: cd packages/broker-login && node_modules/.bin/tsx src/stop-button.ts --clear-hold`;
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
