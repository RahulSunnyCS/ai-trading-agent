import { spawnSync } from 'node:child_process';
import type { Job } from '../jobs.js';
import type { Builtin } from '../runner.js';
import { istDay, tradingDays } from '../schedule.js';
import { type CheckResult, checkBuiltin, checkJob } from './types.js';

/**
 * Credential upkeep (BL-012, "Credentials with a lifetime"). Alert only: nothing here
 * reads, prints or changes a secret. `docs/credentials.md` lists each one.
 */

export interface CommandResult {
  code: number;
  /** Combined stdout and stderr, for the log line only. */
  output: string;
}

/** Runs a command; injected so tests never shell out. */
export type CommandRunner = (cmd: string, args: string[]) => CommandResult;

export function spawnRunner(env: Record<string, string>): CommandRunner {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 30_000 });
    if (r.error) return { code: 127, output: r.error.message };
    return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
}

/** The AlgoTest login dispatch (`gh workflow run`) depends on a working `gh` login. */
export function checkGhAuth(run: CommandRunner): CheckResult {
  const r = run('gh', ['auth', 'status']);
  if (r.code === 0) return { ok: true, detail: 'gh is logged in' };
  const reason = r.output.trim().split('\n')[0] ?? '';
  return {
    ok: false,
    detail: `gh auth status failed (exit ${r.code})${reason ? `: ${reason}` : ''}`,
  };
}

/** True on 1 January: the yearly rotation reminder's day. */
export const firstOfJanuary = (day: string): boolean => day.slice(5) === '01-01';

/** The yearly reminder: it always "fails" on its day so the standard alert fires. */
export function rotationReminder(today: string): CheckResult {
  if (!firstOfJanuary(today)) return { ok: true, detail: 'not the yearly rotation day' };
  return {
    ok: false,
    detail: `Yearly credential rotation (${today.slice(0, 4)}): rotate every credential listed in docs/credentials.md`,
  };
}

export const jobs: Job[] = [
  checkJob({
    id: 'gh-auth-check',
    description: 'Check the gh CLI is logged in (the AlgoTest login dispatch needs it)',
    schedule: { at: '08:36', on: tradingDays, label: 'trading days 08:36' },
    builtin: 'gh-auth-check',
    fixHint: 'gh auth login   (then confirm with: gh auth status)',
  }),
  checkJob({
    id: 'credential-rotation-reminder',
    description: 'Yearly reminder to rotate every credential in docs/credentials.md',
    schedule: {
      at: '08:36',
      on: firstOfJanuary,
      label: '1 January 08:36',
    },
    catchUpHours: 72,
    builtin: 'credential-rotation-reminder',
    fixHint:
      'Open docs/credentials.md and rotate each credential as listed there; this reminder repeats next 1 January',
  }),
];

export const builtins: Record<string, Builtin> = {
  'gh-auth-check': checkBuiltin((ctx) => checkGhAuth(spawnRunner(ctx.env))),
  'credential-rotation-reminder': checkBuiltin((ctx) => rotationReminder(istDay(ctx.now()))),
};
