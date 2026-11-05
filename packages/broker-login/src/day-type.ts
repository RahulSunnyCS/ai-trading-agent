import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type Automation,
  type DayType,
  readAutomation,
  resolveAutomation,
} from './automation-settings.js';
import { istToday } from './strategy-plan.js';

/**
 * BL-211: the settings as they stand for one session. The jobs that read a row's list ask for it
 * through here, never `readAutomation()` alone, so a day-type rule decides the list of the session
 * the job works on: today for the morning and the checks, the next session for the evening.
 *
 * The day type comes from `TRADING_DATA_ROOT/rotation/day-type/<day>.json`, which Python writes
 * (`obt rotation daytype --write`, rotation/day_type.py: the one source of days to expiry); when
 * it is missing, was read from the calendar, or holds an unknown label, Python is asked again.
 * With no rule none of this runs and the settings come back as read.
 */

export type Session = { day: string } | { next: true };

const run = promisify(execFile);

function storedDayType(day: string, env: NodeJS.ProcessEnv): DayType | null {
  const root = env.TRADING_DATA_ROOT?.trim();
  if (!root) return null;
  try {
    const dt = JSON.parse(
      readFileSync(join(root, 'rotation', 'day-type', `${day}.json`), 'utf8'),
    ) as DayType;
    const known = Object.values(dt.dte).every((x) => x !== 'unknown');
    return dt.day === day && dt.source === 'master' && known ? dt : null;
  } catch {
    return null;
  }
}

/** Ask Python for the day type (and have it keep the file). */
async function askPython(args: string[]): Promise<DayType> {
  const { stdout } = await run(
    'uv',
    [
      'run',
      '--directory',
      '../option-backtesting',
      'obt',
      'rotation',
      'daytype',
      '--write',
      '--json',
      ...args,
    ],
    { timeout: 120_000, maxBuffer: 1 << 20 },
  );
  const line = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as DayType;
}

export async function loadDayType(
  session: Session,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DayType> {
  if ('next' in session) return askPython(['--next']);
  return storedDayType(session.day, env) ?? askPython(['--day', session.day]);
}

/** `a` (default: the snapshot) resolved for `session`. Throws when a rule cannot be decided. */
export async function automationForSession(
  session: Session,
  a: Automation = readAutomation(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Automation> {
  if (!a.rules.length) return a;
  return resolveAutomation(a, await loadDayType(session, env));
}

export const todaySession = (): Session => ({ day: istToday() });
