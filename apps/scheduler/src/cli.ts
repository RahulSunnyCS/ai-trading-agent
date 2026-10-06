#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { telegramSink } from './alerts.js';
import { jobEnv } from './env.js';
import { History, pidAlive } from './history.js';
import { JOBS, findJob } from './jobs.js';
import { startLoop } from './loop.js';
import { type RunContext, runJob } from './runner.js';
import { formatIst, nextDue } from './schedule.js';
import { morningSummary } from './summary.js';

/**
 * `bun run jobs status` — every job, its schedule, last run and next run.
 * `bun run jobs run <id>` — run one job now (recorded as a manual run).
 * `bun run jobs serve` — the long-running scheduler (what launchd keeps alive).
 */
const REPO_ROOT = resolve(import.meta.dirname, '../../..');

export function stateDir(): string {
  return (
    process.env.SCHEDULER_STATE_DIR?.trim() ||
    join(homedir(), 'Library', 'Application Support', 'ai-trading-agent')
  );
}

export function logDir(): string {
  return (
    process.env.SCHEDULER_LOG_DIR?.trim() || join(homedir(), 'Library', 'Logs', 'ai-trading-agent')
  );
}

function context(history: History): RunContext {
  return {
    repoRoot: REPO_ROOT,
    env: jobEnv(REPO_ROOT),
    logDir: logDir(),
    history,
    builtins: { 'morning-summary': morningSummary() },
  };
}

function openHistory(): History {
  mkdirSync(stateDir(), { recursive: true });
  return new History(join(stateDir(), 'scheduler.db'));
}

function status(): void {
  const history = openHistory();
  const now = new Date();
  const rows = JOBS.map((job) => {
    const last = history.last(job.id);
    const lastText = !last
      ? '—'
      : last.ended_at === null
        ? `running since ${formatIst(new Date(last.started_at))}`
        : `${last.exit_code === 0 ? 'ok' : `FAILED (${last.error ?? `exit ${last.exit_code}`})`} ${formatIst(new Date(last.started_at))}`;
    const next = nextDue(job.schedule, now);
    return [job.id, job.schedule.label, lastText, next ? formatIst(next) : '—'];
  });
  const header = ['job', 'schedule', 'last run', 'next run'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log(line(header));
  for (const row of rows) console.log(line(row));
  history.close();
}

async function runNow(id: string | undefined): Promise<number> {
  const job = id ? findJob(id) : undefined;
  if (!job) {
    console.error(`unknown job '${id ?? ''}'. Jobs: ${JOBS.map((j) => j.id).join(', ')}`);
    return 2;
  }
  const history = openHistory();
  console.log(`running ${job.id} — log: ${join(logDir(), job.id)}/`);
  const result = await runJob(job, context(history), 'manual');
  history.close();
  console.log(result.ok ? 'ok' : `FAILED: ${result.error}\nlog: ${result.logPath}`);
  return result.ok ? 0 : 1;
}

/** One scheduler per machine: a second loop would run every slot twice. */
function claimInstance(): boolean {
  mkdirSync(stateDir(), { recursive: true });
  const lock = join(stateDir(), 'scheduler.pid');
  try {
    const other = Number(readFileSync(lock, 'utf8'));
    if (other && other !== process.pid && pidAlive(other)) {
      console.error(`another scheduler is already running (pid ${other}); exiting`);
      return false;
    }
  } catch {
    // No lock file yet.
  }
  writeFileSync(lock, String(process.pid));
  return true;
}

function serve(): void {
  if (!claimInstance()) {
    process.exitCode = 1;
    return;
  }
  const ctx = context(openHistory());
  console.log(
    `scheduler started ${formatIst(new Date())} IST — ${JOBS.length} jobs, logs in ${logDir()}`,
  );
  startLoop({ ctx, jobs: JOBS, alerts: telegramSink(ctx.env) });
}

if (import.meta.main) {
  const [command, arg] = process.argv.slice(2);
  if (command === 'status' || command === undefined) status();
  else if (command === 'run') process.exitCode = await runNow(arg);
  else if (command === 'serve') serve();
  else {
    console.error('usage: bun run jobs [status | run <job> | serve]');
    process.exitCode = 2;
  }
}
