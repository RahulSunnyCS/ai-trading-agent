import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isTradingDay } from '@trading/market-reference';
import { type AutomationSettings, pausedFor, validate } from './automation.js';
import { addDays, istDay } from './schedule.js';
import { STOP_HELD_JOBS } from './stop-hold.js';

/**
 * BL-140 Phase 4: while the settings' pause covers a job's session, the jobs that upload, enable
 * or deploy do not run (every path, like the stop button's hold: the schedule, a catch-up,
 * `jobs run`, Apply now): `runJob` records the run as held. The jobs are the stop hold's, which
 * are every job that could change what is on AlgoTest or Quantiply. Logins, the picks, results,
 * the live capture, the read-only checks and the 15:40 Quantiply switch-off keep running, and
 * nothing already uploaded or enabled is removed.
 *
 * A pause covers a session, not a clock time: the evening jobs prepare the next trading session,
 * the morning top-ups and deploys are for today. `until` is the last paused session, inclusive.
 *
 * Settings that cannot be read hold the job too, saying so: a pause must never fail open. No file
 * (the scheduler never saved one) is no pause.
 */
export const PAUSE_JOBS: readonly string[] = STOP_HELD_JOBS;

/** The jobs that prepare the next trading session instead of today's. */
const EVENING_JOBS: readonly string[] = [
  'algotest-evening',
  'quantiply-evening',
  'quantiply-deploy',
];

/** Beside the scheduler's database; the same file the jobs read. */
export function settingsFile(env: Record<string, string>): string {
  const dir =
    env.SCHEDULER_STATE_DIR?.trim() ||
    join(homedir(), 'Library', 'Application Support', 'ai-trading-agent');
  return join(dir, 'automation-settings.json');
}

/** The session a job is for: the next trading day after `today` for an evening job, else today. */
export function sessionFor(jobId: string, today: string): string {
  if (!EVENING_JOBS.includes(jobId)) return today;
  let day = addDays(today, 1);
  while (!isTradingDay(day)) day = addDays(day, 1);
  return day;
}

function readSettings(path: string): AutomationSettings | null | { error: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { error: String(error) };
  }
  try {
    // the snapshot is the settings plus the version and when it was saved
    const {
      version: _version,
      saved_at: _savedAt,
      ...settings
    } = JSON.parse(text) as Record<string, unknown>;
    const checked = validate(settings);
    return 'settings' in checked ? checked.settings : { error: checked.errors.join('; ') };
  } catch (error) {
    return { error: String(error) };
  }
}

/** Why this job must not run now because of the pause, or null. */
export function pausedReason(
  jobId: string,
  env: Record<string, string>,
  now: Date = new Date(),
): string | null {
  if (!PAUSE_JOBS.includes(jobId)) return null;
  const settings = readSettings(settingsFile(env));
  if (settings === null) return null;
  if ('error' in settings) {
    return `held: the automation settings cannot be read (${settings.error}), so a pause cannot be ruled out`;
  }
  const session = sessionFor(jobId, istDay(now));
  const until = pausedFor(settings, session);
  return until
    ? `held: paused until ${until} (Settings › Automation); nothing is uploaded, enabled or deployed for the ${session} session`
    : null;
}

/**
 * For the 09:00 summary: the pause's last day when it still covers today or later, or null. A
 * pause that cannot be read is said too (never silent).
 */
export function pauseNotice(env: Record<string, string>, now: Date = new Date()): string | null {
  const settings = readSettings(settingsFile(env));
  if (settings === null) return null;
  if ('error' in settings) return `the automation settings cannot be read (${settings.error})`;
  const until = settings.pause.until;
  return until !== null && until >= istDay(now) ? until : null;
}

/**
 * The first session an upload or deploy would still change: today until the last morning job
 * (the 09:21 Quantiply deploy top-up) has run on a trading day, otherwise the next trading day.
 * "Skip next session" pauses through it.
 */
export function nextSession(now: Date = new Date()): string {
  const today = istDay(now);
  const minutes = Math.floor(((now.getTime() + 330 * 60_000) % 86_400_000) / 60_000);
  if (isTradingDay(today) && minutes < 9 * 60 + 22) return today;
  let day = addDays(today, 1);
  while (!isTradingDay(day)) day = addDays(day, 1);
  return day;
}
