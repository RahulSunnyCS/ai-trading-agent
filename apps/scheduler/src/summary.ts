import { spawnSync } from 'node:child_process';
import { readdirSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isTradingDay } from '@trading/market-reference';
import { type AlertSink, telegramSink } from './alerts.js';
import { JOBS } from './jobs.js';
import type { Builtin, BuiltinContext } from './runner.js';
import { addDays, formatIst, istDay, previousDue } from './schedule.js';

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
    if (!slot || istDay(slot) !== today) continue;
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
      '1',
      '--json',
      'conclusion,status,createdAt,url',
    ],
    ctx.repoRoot,
    ctx.env,
  );
  try {
    const [run] = JSON.parse(raw) as Array<{
      conclusion: string;
      status: string;
      createdAt: string;
      url: string;
    }>;
    if (!run || istDay(new Date(run.createdAt)) !== istDay(ctx.now())) {
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

function diskCheck(): Check {
  const stats = statfsSync(homedir());
  const freeGb = (stats.bavail * stats.bsize) / 1e9;
  return { ok: freeGb >= 20, label: 'Disk', detail: `${freeGb.toFixed(0)} GB free` };
}

/** Failures and misses in the last 24 h that are not today's slots (those are listed above). */
function recentFailures(ctx: BuiltinContext, today: Check[]): Check[] {
  const listed = new Set(today.map((c) => c.label));
  const since = new Date(ctx.now().getTime() - 86_400_000);
  return ctx.history
    .failuresSince(since)
    .filter((r) => !listed.has(r.job))
    .map((r) => ({
      ok: false,
      label: r.job,
      detail: `${r.error ?? 'failed'} (${formatIst(new Date(r.started_at))})`,
    }));
}

export function morningSummary(sink?: AlertSink): Builtin {
  return async (ctx) => {
    const jobs = jobChecks(ctx);
    const checks = [
      ...jobs,
      algotestCheck(ctx),
      fyersCheck(ctx),
      optionsDataCheck(ctx),
      diskCheck(),
      ...recentFailures(ctx, jobs),
    ];
    const { text } = formatSummary(istDay(ctx.now()), checks);
    ctx.log(text);
    await (sink ?? telegramSink(ctx.env))(text);
    return { code: 0, error: null };
  };
}
