import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Job } from '../jobs.js';
import type { Builtin } from '../runner.js';
import { tradingDays } from '../schedule.js';
import type { CommandRunner } from './credentials.js';
import { type CheckResult, checkBuiltin, checkJob } from './types.js';

/**
 * BL-143 item 7: at 09:00 on a trading day, alert when there is no valid Fyers token for today.
 * The 09:16 pick's VIX read and the evening collection (15:45) need one, a Fyers token dies at
 * 06:00 IST, and nothing renews it unattended (its login page has a human check), so the owner
 * logs in by hand on Broker logins. On by default; alert only: it reads where the token would
 * come from and when it expires (`mbt token-status`, which never prints the token).
 */
export function fyersTokenCheck(run: CommandRunner, momentumDir: string): CheckResult {
  const r = run('uv', ['run', '--directory', momentumDir, 'mbt', 'token-status']);
  const line =
    r.output
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('ok:') || l.startsWith('not ready:')) ?? '';
  if (r.code === 0 && line.startsWith('ok:')) {
    return { ok: true, detail: `Fyers token ${line.replace(/^ok:\s*/, '')}` };
  }
  const why =
    line.replace(/^not ready:\s*/, '') || r.output.trim().split('\n')[0] || `exit ${r.code}`;
  return { ok: false, detail: `No valid Fyers token for today: ${why}` };
}

/** `uv run` may sync the environment first: a longer timeout than the other checks' 30 s. */
function uvRunner(env: Record<string, string>): CommandRunner {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 120_000 });
    if (r.error) return { code: 127, output: r.error.message };
    return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
}

export const jobs: Job[] = [
  checkJob({
    id: 'fyers-token-reminder',
    description:
      "Remind to log in to Fyers when today's token is missing or expired (the 09:16 pick and the evening collection need it)",
    schedule: { at: '09:00', on: tradingDays, label: 'trading days 09:00' },
    builtin: 'fyers-token-reminder',
    // until 15:00: after that the evening run's own retries say the same thing
    catchUpHours: 6,
    fixHint:
      'Dashboard › Broker logins › Fyers › Log in (then: cd packages/momentum-backtesting && uv run mbt token-status)',
  }),
];

export const builtins: Record<string, Builtin> = {
  'fyers-token-reminder': checkBuiltin((ctx) =>
    fyersTokenCheck(uvRunner(ctx.env), join(ctx.repoRoot, 'packages/momentum-backtesting')),
  ),
};
