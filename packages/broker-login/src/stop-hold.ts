import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from './secrets.js';
import { istToday } from './strategy-plan.js';

/**
 * BL-143 Phase 4: the stop button's hold marker and log, under `TRADING_DATA_ROOT/stop/`.
 *
 * - `hold-<IST day>.json`: written first by a confirmed stop. While today's exists, the AlgoTest
 *   deployer (`strategy-deploy.ts`), both uploaders (`strategy-upload.ts`, `quantiply-upload.ts`)
 *   and the Quantiply enabler (`quantiply-deploy.ts --mode enable`) change nothing with `--apply`,
 *   and the scheduler pauses their jobs (`apps/scheduler/src/stop-hold.ts`, the same path). It holds
 *   for the rest of the IST day only: tomorrow's file name is different. The disable safety net is
 *   never held.
 * - `<IST day>.jsonl`: every step of the day's stop, from the listener (the taps) and the runner
 *   (each call and its answer), one JSON line each. Never a token or a password (redacted).
 */

export function stopDir(dataRoot: string): string {
  return join(dataRoot, 'stop');
}

export function holdPath(dataRoot: string, day: string): string {
  return join(stopDir(dataRoot), `hold-${day}.json`);
}

export function stopLogPath(dataRoot: string, day: string): string {
  return join(stopDir(dataRoot), `${day}.jsonl`);
}

export interface Hold {
  day: string;
  at: string;
  by: string;
}

/** Today's hold, or null. An unreadable file still holds (it exists): never fail open. */
export function readHold(dataRoot: string, day: string = istToday()): Hold | null {
  const path = holdPath(dataRoot, day);
  if (!existsSync(path)) return null;
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as Partial<Hold>;
    return { day, at: String(h.at ?? '?'), by: String(h.by ?? '?') };
  } catch {
    return { day, at: '?', by: 'unreadable hold file' };
  }
}

export async function writeHold(
  dataRoot: string,
  by: string,
  now: Date = new Date(),
): Promise<string> {
  const day = istToday(now);
  await mkdir(stopDir(dataRoot), { recursive: true });
  const path = holdPath(dataRoot, day);
  await writeFile(path, `${JSON.stringify({ day, at: now.toISOString(), by })}\n`, 'utf8');
  return path;
}

export async function clearHold(dataRoot: string, day: string = istToday()): Promise<boolean> {
  const path = holdPath(dataRoot, day);
  if (!existsSync(path)) return false;
  await rm(path);
  return true;
}

/**
 * For the deployers and uploaders: why an `--apply` run must change nothing today, or null.
 * Reads `TRADING_DATA_ROOT` from the environment; without it there is no hold to find.
 */
export function stopHeld(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): string | null {
  const root = env.TRADING_DATA_ROOT?.trim();
  if (!root) return null;
  const hold = readHold(root, istToday(now));
  if (!hold) return null;
  return `held by the stop button since ${hold.at} (${holdPath(root, hold.day)}): nothing changed today. Clear it with: tsx src/stop-button.ts --clear-hold`;
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
