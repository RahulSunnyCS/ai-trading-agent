import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { History, Trigger } from './history.js';
import { JOBS, type Job } from './jobs.js';
import { formatIst, istDay } from './schedule.js';

export interface RunContext {
  repoRoot: string;
  env: Record<string, string>;
  logDir: string;
  history: History;
  now?: () => Date;
  /** How long to wait between checks when the job's group is busy in another process. */
  busyPollMs?: number;
  /** Override the job list used for group membership (tests). */
  jobs?: Job[];
}

export interface RunResult {
  runId: number;
  ok: boolean;
  exitCode: number;
  attempts: number;
  logPath: string;
  error: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exit code used when a step's executable can't be found, as a shell would. */
const NOT_FOUND = 127;
/** Exit code recorded for a step killed at its timeout. */
const TIMED_OUT = 124;

function resolveExecutable(cmd: string, cwd: string, path: string): string | null {
  if (cmd.includes('/')) return isAbsolute(cmd) ? cmd : join(cwd, cmd);
  return Bun.which(cmd, { PATH: path });
}

function runStep(
  step: string[],
  cwd: string,
  env: Record<string, string>,
  logFd: number,
  timeoutMs: number,
): Promise<{ code: number; error: string | null }> {
  const [cmd = '', ...args] = step;
  const exe = resolveExecutable(cmd, cwd, env.PATH ?? '');
  if (!exe) return Promise.resolve({ code: NOT_FOUND, error: `${cmd}: not found on PATH` });
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, env, stdio: ['ignore', logFd, logFd] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: NOT_FOUND, error: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut)
        resolve({ code: TIMED_OUT, error: `timed out after ${timeoutMs / 60_000} min` });
      else resolve({ code: code ?? 1, error: signal ? `killed by ${signal}` : null });
    });
  });
}

/** In-process serialisation per group; the history table covers other processes. */
const groupChains = new Map<string, Promise<unknown>>();

function withGroup<T>(group: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!group) return fn();
  const previous = groupChains.get(group) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  groupChains.set(
    group,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * Wait while another process (e.g. `jobs run` next to the running scheduler)
 * has a job of the same group in flight. Gives up after the job's own timeout.
 */
async function waitForGroup(job: Job, ctx: RunContext, now: () => Date): Promise<string | null> {
  if (!job.group) return null;
  const jobs = ctx.jobs ?? JOBS;
  const members = jobs.filter((j) => j.group === job.group);
  const longest = Math.max(...members.map((j) => j.timeoutMinutes)) * 60_000;
  const deadline = now().getTime() + job.timeoutMinutes * 60_000;
  for (;;) {
    const busy = ctx.history.running(
      members.map((j) => j.id),
      new Date(now().getTime() - longest),
    );
    if (busy.length === 0) return null;
    if (now().getTime() >= deadline) {
      return `group '${job.group}' still busy with ${busy.map((r) => r.job).join(', ')}`;
    }
    await sleep(ctx.busyPollMs ?? 30_000);
  }
}

/**
 * Run one job: every step in order, retried as a whole on failure, output
 * appended to `<logDir>/<job>/<IST date>.log`, the outcome recorded in history.
 * Never throws — the result says what happened.
 */
export function runJob(
  job: Job,
  ctx: RunContext,
  trigger: Trigger,
  scheduledFor: Date | null = null,
): Promise<RunResult> {
  return withGroup(job.group, async () => {
    const now = ctx.now ?? (() => new Date());
    const dir = join(ctx.logDir, job.id);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `${istDay(now())}.log`);
    const cwd = join(ctx.repoRoot, job.cwd);

    const blocked = await waitForGroup(job, ctx, now);
    const runId = ctx.history.start(job.id, trigger, scheduledFor, logPath, now());
    if (blocked) {
      ctx.history.finish(runId, 1, 0, now(), blocked);
      return { runId, ok: false, exitCode: 1, attempts: 0, logPath, error: blocked };
    }

    const fd = openSync(logPath, 'a');
    let result = { code: 1, error: null as string | null };
    let attempts = 0;
    try {
      for (attempts = 1; attempts <= job.retries + 1; attempts++) {
        writeSync(
          fd,
          `\n=== ${job.id} · ${trigger} · attempt ${attempts} · ${formatIst(now())} IST\n`,
        );
        for (const step of job.steps) {
          writeSync(fd, `$ ${step.join(' ')}\n`);
          result = await runStep(step, cwd, ctx.env, fd, job.timeoutMinutes * 60_000);
          if (result.error) writeSync(fd, `! ${result.error}\n`);
          if (result.code !== 0) break;
        }
        writeSync(fd, `=== exit ${result.code}\n`);
        if (result.code === 0 || attempts > job.retries) break;
        await sleep(job.retryDelayMinutes * 60_000);
      }
    } finally {
      closeSync(fd);
    }
    attempts = Math.min(attempts, job.retries + 1);
    const error = result.code === 0 ? null : (result.error ?? `exit ${result.code}`);
    ctx.history.finish(runId, result.code, attempts, now(), error);
    return { runId, ok: result.code === 0, exitCode: result.code, attempts, logPath, error };
  });
}
