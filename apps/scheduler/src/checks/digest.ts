import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isTradingDay } from '@trading/market-reference';
import { telegramSink } from '../alerts.js';
import type { RunRow } from '../history.js';
import type { Job } from '../jobs.js';
import type { Builtin, BuiltinContext } from '../runner.js';
import { addDays, formatIst, istDay, onWeekdays } from '../schedule.js';
import { checkJob } from './types.js';

/**
 * Saturday health digest (BL-012 Phase 3b): one message with the week at a glance.
 * Green items collapse to a single line; only problems get their own line.
 * Covers today: CI on main, every job's runs over the last 7 days, the last options day in
 * the lake and the last backup. The forward journal against the backtest (BL-024) and the
 * live-money rules (BL-025) join it when those items ship.
 */

export interface CiRun {
  conclusion: string | null;
  status: string;
  createdAt: string;
  url: string;
}

export interface JobWeek {
  job: string;
  ok: number;
  failed: number;
  missed: number;
  last: string | null;
}

export interface DigestFacts {
  /** null = could not ask GitHub. */
  ciRuns: CiRun[] | null;
  jobs: JobWeek[];
  optionsLastDay: string | null;
  optionsExpected: string;
  backupLast: string | null;
}

/** Per job, what happened over the runs in `rows` (already limited to the week). */
export function summariseJobs(rows: RunRow[], jobIds: string[]): JobWeek[] {
  return jobIds.map((id) => {
    const done = rows
      .filter((r) => r.job === id && r.ended_at !== null)
      .sort((a, b) => a.id - b.id);
    const last = done.at(-1);
    return {
      job: id,
      ok: done.filter((r) => r.exit_code === 0).length,
      // -1 marks a slot recorded as missed (never ran); every other non-zero code is a failure.
      failed: done.filter((r) => r.exit_code !== 0 && r.exit_code !== -1).length,
      missed: done.filter((r) => r.exit_code === -1).length,
      last: last ? (last.exit_code === 0 ? 'ok' : (last.error ?? `exit ${last.exit_code}`)) : null,
    };
  });
}

export function formatDigest(day: string, f: DigestFacts): { ok: boolean; text: string } {
  const problems: string[] = [];
  const green: string[] = [];

  if (f.ciRuns === null) problems.push('CI on main: could not ask GitHub');
  else if (f.ciRuns.length === 0) problems.push('CI on main: no recent runs');
  else {
    const latest = f.ciRuns[0] as CiRun;
    if (latest.status !== 'completed') green.push('CI on main running');
    else if (latest.conclusion === 'success') green.push('CI on main passing');
    else problems.push(`CI on main: latest run ${latest.conclusion} → ${latest.url}`);
  }

  const troubled = f.jobs.filter((j) => j.failed > 0 || j.missed > 0);
  for (const j of troubled) {
    const parts = [`${j.ok} ok`];
    if (j.failed) parts.push(`${j.failed} failed`);
    if (j.missed) parts.push(`${j.missed} missed`);
    const last = j.last && j.last !== 'ok' ? ` (last: ${j.last})` : '';
    problems.push(`${j.job}: ${parts.join(', ')}${last}`);
  }
  if (troubled.length === 0) {
    const runs = f.jobs.reduce((n, j) => n + j.ok, 0);
    green.push(`${runs} job runs, none failed or missed`);
  }

  if (f.optionsLastDay === null) problems.push('Options data: no lake found');
  else if (f.optionsLastDay < f.optionsExpected) {
    problems.push(`Options data: last day ${f.optionsLastDay}, expected ${f.optionsExpected}`);
  } else green.push(`options data through ${f.optionsLastDay}`);

  green.push(f.backupLast ? `last backup ${f.backupLast}` : 'no backup recorded yet');

  const head =
    problems.length === 0
      ? `✅ Weekly health ${day}: all green`
      : `⚠️ Weekly health ${day}: ${problems.length} problem${problems.length === 1 ? '' : 's'}`;
  const lines = [head, '', ...problems.map((p) => `❌ ${p}`), `✅ ${green.join(' · ')}`];
  return { ok: problems.length === 0, text: lines.join('\n') };
}

function capture(cmd: string, args: string[], cwd: string, env: Record<string, string>): string {
  const out = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return (out.stdout ?? '').trim();
}

function ciRuns(ctx: BuiltinContext): CiRun[] | null {
  const raw = capture(
    'gh',
    [
      'run',
      'list',
      '--branch',
      'main',
      '--workflow',
      'ci.yml',
      '--limit',
      '5',
      '--json',
      'conclusion,status,createdAt,url',
    ],
    ctx.repoRoot,
    ctx.env,
  );
  try {
    return JSON.parse(raw) as CiRun[];
  } catch {
    return null;
  }
}

function lakeLastDay(ctx: BuiltinContext): string | null {
  const root = ctx.env.TRADING_DATA_ROOT?.trim() || join(homedir(), 'TradingData');
  const dir = join(root, 'lake', 'bars_1m', 'asset=option', 'underlying=NIFTY');
  try {
    return (
      readdirSync(dir)
        .filter((d) => d.startsWith('date='))
        .map((d) => d.slice(5))
        .sort()
        .at(-1) ?? null
    );
  } catch {
    return null;
  }
}

/** The last NSE trading day on or before `day` (a Saturday is never one). */
export function lastTradingDay(day: string, isTrading: (d: string) => boolean): string {
  let d = day;
  while (!isTrading(d)) d = addDays(d, -1);
  return d;
}

export function gatherFacts(
  ctx: BuiltinContext,
  jobIds: string[],
  isTrading: (day: string) => boolean,
): DigestFacts {
  const since = new Date(ctx.now().getTime() - 7 * 86_400_000).toISOString();
  const rows = ctx.history.recent(2000).filter((r) => r.started_at >= since);
  const backup = ctx.history.last('backup');
  return {
    ciRuns: ciRuns(ctx),
    jobs: summariseJobs(rows, jobIds),
    optionsLastDay: lakeLastDay(ctx),
    optionsExpected: lastTradingDay(istDay(ctx.now()), isTrading),
    backupLast:
      backup?.ended_at && backup.exit_code === 0 ? formatIst(new Date(backup.ended_at)) : null,
  };
}

export function weeklyDigest(
  jobList: () => Job[],
  sink?: (text: string) => Promise<void>,
  isTrading: (day: string) => boolean = isTradingDay,
): Builtin {
  return async (ctx) => {
    const ids = jobList()
      .filter((j) => j.builtin !== 'weekly-digest')
      .map((j) => j.id);
    const { text } = formatDigest(istDay(ctx.now()), gatherFacts(ctx, ids, isTrading));
    ctx.log(text);
    await (sink ?? telegramSink(ctx.env, 'scheduler.digest'))(text);
    return { code: 0, error: null };
  };
}

export const jobs: Job[] = [
  checkJob({
    id: 'weekly-digest',
    description: 'Saturday health digest: CI on main, the week’s job runs, data freshness, backup',
    schedule: { at: '09:00', on: onWeekdays(6), label: 'Saturday 09:00' },
    builtin: 'weekly-digest',
    fixHint: 'bun run --filter @ata/scheduler jobs run weekly-digest',
  }),
];

// The job list is read lazily: jobs.ts imports this module, so importing JOBS here would be circular.
export const builtins: Record<string, Builtin> = {
  'weekly-digest': async (ctx) => {
    const { JOBS } = await import('../jobs.js');
    return weeklyDigest(() => ctx.jobs ?? JOBS)(ctx);
  },
};
