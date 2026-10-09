import { spawnSync } from 'node:child_process';
import { readdirSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isTradingDay } from '@trading/market-reference';
import { type AlertSink, telegramSink } from './alerts.js';
import { JOBS } from './jobs.js';
import type { Builtin, BuiltinContext } from './runner.js';
import { addDays, formatIst, istAt, istDay, previousDue } from './schedule.js';

/** One line of the summary: ok, or a problem with what to do about it. */
export interface Check {
  ok: boolean;
  label: string;
  detail: string;
}

export function formatSummary(day: string, checks: Check[]): { ok: boolean; text: string } {
  const problems = checks.filter((c) => !c.ok).length;
  const head =
    problems === 0
      ? `✅ Morning check ${day}: all good`
      : `⚠️ Morning check ${day}: ${problems} problem${problems === 1 ? '' : 's'}`;
  const lines = checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.label}: ${c.detail}`);
  return { ok: problems === 0, text: [head, '', ...lines].join('\n') };
}

/** Today's slots of every job due by now: ran ok, failed, missed, or not run. */
export function jobChecks(ctx: BuiltinContext): Check[] {
  const now = ctx.now();
  const today = istDay(now);
  const checks: Check[] = [];
  for (const job of ctx.jobs ?? JOBS) {
    if (job.builtin === 'morning-summary') continue;
    const slot = previousDue(job.schedule, now);
    // Slots before the scheduler first saw the job belonged to launchd, or to no one.
    if (!slot || istDay(slot) !== today || slot < ctx.history.jobFirstSeen(job.id, now)) continue;
    const run = ctx.history.forSlot(job.id, slot);
    if (!run) checks.push({ ok: false, label: job.id, detail: 'has not run yet' });
    else if (run.ended_at === null) checks.push({ ok: true, label: job.id, detail: 'running' });
    else if (run.exit_code === 0) {
      checks.push({
        ok: true,
        label: job.id,
        detail: `ok at ${formatIst(new Date(run.started_at))}`,
      });
    } else {
      checks.push({
        ok: false,
        label: job.id,
        detail: `${run.error ?? 'failed'} → ${job.fixHint}`,
      });
    }
  }
  return checks;
}

function capture(cmd: string, args: string[], cwd: string, env: Record<string, string>): string {
  const out = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return `${out.stdout ?? ''}${out.stderr ?? ''}`.trim();
}

/** Did today's AlgoTest login workflow (dispatched at 08:00) succeed? */
function algotestCheck(ctx: BuiltinContext): Check {
  const label = 'AlgoTest login';
  const raw = capture(
    'gh',
    [
      'run',
      'list',
      '--workflow',
      'daily-broker-login.yml',
      '--limit',
      '10',
      '--json',
      'conclusion,status,createdAt,url',
    ],
    ctx.repoRoot,
    ctx.env,
  );
  try {
    const runs = JSON.parse(raw) as Array<{
      conclusion: string;
      status: string;
      createdAt: string;
      url: string;
    }>;
    // Any successful run today counts: GitHub's late backstop cron can fail hours after
    // the 08:00 dispatch already logged both brokers in.
    const today = runs.filter((r) => istDay(new Date(r.createdAt)) === istDay(ctx.now()));
    const run = today.find((r) => r.conclusion === 'success') ?? today[0];
    if (!run) {
      return {
        ok: false,
        label,
        detail: 'no run today → start "Daily broker login" in GitHub Actions',
      };
    }
    if (run.status !== 'completed') return { ok: true, label, detail: `still ${run.status}` };
    return run.conclusion === 'success'
      ? { ok: true, label, detail: 'both brokers logged in' }
      : { ok: false, label, detail: `${run.conclusion} → ${run.url}` };
  } catch {
    return {
      ok: false,
      label,
      detail: `could not ask GitHub (${raw.slice(0, 120) || 'no output'})`,
    };
  }
}

/** Is there a usable Fyers token (the evening collection needs one)? */
function fyersCheck(ctx: BuiltinContext): Check {
  const out = capture(
    'uv',
    ['run', 'mbt', 'token-status'],
    join(ctx.repoRoot, 'packages/momentum-backtesting'),
    ctx.env,
  );
  const line =
    out.split('\n').find((l) => l.startsWith('ok:') || l.startsWith('not ready:')) ??
    out.slice(0, 160);
  return {
    ok: line.startsWith('ok:'),
    label: 'Fyers token',
    detail: line.replace(/^(ok|not ready):\s*/, ''),
  };
}

/** Was the last trading day's options data collected? Expired contracts can't be fetched later. */
function optionsDataCheck(ctx: BuiltinContext): Check {
  const label = 'Options data';
  const root = ctx.env.TRADING_DATA_ROOT?.trim() || join(homedir(), 'TradingData');
  const dir = join(root, 'lake', 'bars_1m', 'asset=option', 'underlying=NIFTY');
  let last = '';
  try {
    last =
      readdirSync(dir)
        .filter((d) => d.startsWith('date='))
        .map((d) => d.slice(5))
        .sort()
        .at(-1) ?? '';
  } catch {
    return { ok: false, label, detail: `no lake at ${dir}` };
  }
  let expected = addDays(istDay(ctx.now()), -1);
  while (!isTradingDay(expected)) expected = addDays(expected, -1);
  return last >= expected
    ? { ok: true, label, detail: `collected through ${last}` }
    : {
        ok: false,
        label,
        detail: `last day ${last || 'none'}, expected ${expected} → cd packages/option-backtesting && uv run obt daily --date ${expected}`,
      };
}

/**
 * Jobs run from this checkout's working tree, so whatever branch is checked out
 * here is the code that runs — a feature branch left checked out runs at 08:00.
 */
function checkoutCheck(ctx: BuiltinContext): Check {
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], ctx.repoRoot, ctx.env);
  return branch === 'main'
    ? { ok: true, label: 'Checkout', detail: 'on main' }
    : {
        ok: false,
        label: 'Checkout',
        detail: `jobs run from ${ctx.repoRoot}, which is on '${branch}' → git switch main`,
      };
}

function diskCheck(): Check {
  const stats = statfsSync(homedir());
  const freeGb = (stats.bavail * stats.bsize) / 1e9;
  return { ok: freeGb >= 20, label: 'Disk', detail: `${freeGb.toFixed(0)} GB free` };
}

/** Failures and misses in the last 24 h that are not today's slots (those are listed above). */
function recentFailures(ctx: BuiltinContext, today: Check[]): Check[] {
  const listed = new Set(today.map((c) => c.label));
  // From the start of the previous trading day, so Monday's summary still lists a Friday
  // evening failure (self-alerting jobs stay silent when they die before alerting).
  let previousDay = addDays(istDay(ctx.now()), -1);
  while (!isTradingDay(previousDay)) previousDay = addDays(previousDay, -1);
  const since = istAt(previousDay, '00:00');
  return ctx.history
    .failuresSince(since)
    .filter((r) => !listed.has(r.job))
    .map((r) => ({
      ok: false,
      label: r.job,
      detail: `${r.error ?? 'failed'} (${formatIst(new Date(r.started_at))})`,
    }));
}

/** The checks that look outside the history table: GitHub, Fyers, the lake, git, the disk. */
export type SystemChecks = (ctx: BuiltinContext) => Check[];

const systemChecks: SystemChecks = (ctx) => [
  algotestCheck(ctx),
  fyersCheck(ctx),
  optionsDataCheck(ctx),
  checkoutCheck(ctx),
  diskCheck(),
];

/** `system` is injectable so a test needs no `gh`, `uv`, git or network. */
export function morningSummary(sink?: AlertSink, system: SystemChecks = systemChecks): Builtin {
  return async (ctx) => {
    const jobs = jobChecks(ctx);
    const checks = [...jobs, ...system(ctx), ...recentFailures(ctx, jobs)];
    const { text } = formatSummary(istDay(ctx.now()), checks);
    ctx.log(text);
    await (sink ?? telegramSink(ctx.env, 'scheduler.morning'))(text);
    return { code: 0, error: null };
  };
}
