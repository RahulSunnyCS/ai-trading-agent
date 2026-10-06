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
  /** In-process jobs (`Job.builtin`), e.g. the morning summary. */
  builtins?: Record<string, Builtin>;
}

export interface BuiltinContext extends RunContext {
  now: () => Date;
  /** Append a line to the run's log. */
  log: (text: string) => void;
}

/** An in-process job. Returns an exit code like a step would. */
export type Builtin = (ctx: BuiltinContext) => Promise<{ code: number; error: string | null }>;

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
async function waitForGroup(
  job: Job,
  runId: number,
  ctx: RunContext,
  now: () => Date,
): Promise<string | null> {
  if (!job.group) return null;
  const jobs = ctx.jobs ?? JOBS;
  const members = jobs.filter((j) => j.group === job.group).map((j) => j.id);
  const deadline = now().getTime() + job.timeoutMinutes * 60_000;
  for (;;) {
    ctx.history.reapDead(now());
    const busy = ctx.history.runningBefore(members, runId);
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
    const logPath = join(dir, `${istDay(now())}.log`);
    const cwd = join(ctx.repoRoot, job.cwd);

    // The row goes in first: waiting for the group is then ordered by id, and a crash
    // while waiting or running leaves a row that reapDead can close.
    const runId = ctx.history.start(job.id, trigger, scheduledFor, logPath, now());
    let fd: number | null = null;
    let result = { code: 1, error: null as string | null };
    let attempts = 0;
    try {
      mkdirSync(dir, { recursive: true });
      const blocked = await waitForGroup(job, runId, ctx, now);
      if (blocked) {
        ctx.history.finish(runId, 1, 0, now(), blocked);
        return { runId, ok: false, exitCode: 1, attempts: 0, logPath, error: blocked };
      }
      fd = openSync(logPath, 'a');
      const logFd = fd;
      for (attempts = 1; attempts <= job.retries + 1; attempts++) {
        writeSync(
          logFd,
          `\n=== ${job.id} · ${trigger} · attempt ${attempts} · ${formatIst(now())} IST\n`,
        );
        if (job.builtin) {
          const builtin = ctx.builtins?.[job.builtin];
          result = builtin
            ? await builtin({ ...ctx, now, log: (text) => writeSync(logFd, `${text}\n`) }).catch(
                (error: unknown) => ({
                  code: 1,
                  error: error instanceof Error ? error.message : String(error),
                }),
              )
            : { code: NOT_FOUND, error: `builtin '${job.builtin}' is not registered` };
          if (result.error) writeSync(fd, `! ${result.error}\n`);
        }
        for (const step of job.steps) {
          writeSync(logFd, `$ ${step.join(' ')}\n`);
          result = await runStep(step, cwd, ctx.env, logFd, job.timeoutMinutes * 60_000);
          if (result.error) writeSync(logFd, `! ${result.error}\n`);
          if (result.code !== 0) break;
        }
        writeSync(logFd, `=== exit ${result.code}\n`);
        if (result.code === 0 || attempts > job.retries) break;
        await sleep(job.retryDelayMinutes * 60_000);
      }
    } catch (error) {
      // Never throw: say what happened and close the row so it cannot block its group.
      const message = error instanceof Error ? error.message : String(error);
      ctx.history.finish(runId, 1, attempts, now(), message);
      return { runId, ok: false, exitCode: 1, attempts, logPath, error: message };
    } finally {
      if (fd !== null) closeSync(fd);
    }
    attempts = Math.min(attempts, job.retries + 1);
    const error = result.code === 0 ? null : (result.error ?? `exit ${result.code}`);
    ctx.history.finish(runId, result.code, attempts, now(), error);
    return { runId, ok: result.code === 0, exitCode: result.code, attempts, logPath, error };
  });
}
