import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type ChainResult, type StepOutcome, runChain } from './chain.js';
import type { History, StepRow, Trigger } from './history.js';
import { JOBS, type Job, groupsOf } from './jobs.js';
import { pausedReason } from './pause.js';
import { formatIst, istAt, istDay } from './schedule.js';
import { NOT_FOUND, runStep } from './step.js';
import { heldReason } from './stop-hold.js';

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
  /** Waits for a chain step's `notBefore` and retry delays; tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
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
  /** BL-234: what each step of a chain came to; absent for a job that is not a chain. */
  steps?: StepOutcome[];
}

/** How a chain run starts (BL-234); a job that is not a chain ignores them. */
export interface RunOptions {
  /** Resume the earlier run of today: its steps that passed are not run again. */
  resume?: boolean;
  /** Start at this step; every step before it counts as done (implies resume). */
  from?: string;
  /** Ignore any earlier run: every step runs. */
  fresh?: boolean;
  /** Run only these steps (the dashboard's Apply now); the others count as done. No resume. */
  only?: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In-process serialisation per group (a FIFO mutex); the history table covers other processes.
 * `acquireGroup` resolves with the release function once every earlier holder has released.
 */
const groupTails = new Map<string, Promise<void>>();

function acquireGroup(group: string): Promise<() => void> {
  const previous = groupTails.get(group) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  groupTails.set(
    group,
    previous.then(() => gate),
  );
  return previous.then(() => release);
}

async function withGroup<T>(group: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireGroup(group);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** All of `groups`, in a fixed order so two runs holding several never wait on each other. */
function withGroups<T>(groups: readonly string[], fn: () => Promise<T>): Promise<T> {
  const [first, ...rest] = groups;
  if (first === undefined) return fn();
  return withGroup(first, () => withGroups(rest, fn));
}

/**
 * Wait while another process (e.g. `jobs run` next to the running scheduler)
 * has a job of the same group in flight. Gives up after the job's own timeout.
 */
async function waitForGroup(
  job: Job,
  groups: readonly string[],
  runId: number,
  ctx: RunContext,
  now: () => Date,
  /**
   * Wait only for older runs (a job's start, so two that start together order themselves by id), or
   * for any run that holds the group (a chain step, which meets a newer holder too).
   */
  olderOnly = true,
): Promise<string | null> {
  if (groups.length === 0) return null;
  const jobs = ctx.jobs ?? JOBS;
  const deadline = now().getTime() + job.timeoutMinutes * 60_000;
  for (;;) {
    ctx.history.reapDead(now());
    const busy = new Map<number, string>();
    for (const group of groups) {
      // a job's own `group` is held for its whole run; a chain's steps' groups, while it holds them
      const own = jobs.filter((j) => j.group === group).map((j) => j.id);
      const holders = ctx.history.groupHolders(
        group,
        own,
        runId,
        olderOnly ? runId : Number.MAX_SAFE_INTEGER,
      );
      for (const row of holders) busy.set(row.id, row.job);
    }
    if (busy.size === 0) return null;
    if (now().getTime() >= deadline) {
      return `group '${groups.join("', '")}' still busy with ${[...busy.values()].join(', ')}`;
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
  options: RunOptions = {},
): Promise<RunResult> {
  // The job's own group is held from the start. A chain's steps take theirs when they get to them
  // (BL-234), so a chain that starts at 15:45 does not wait for the 15:30 close-out's group until
  // its first step that needs it.
  const groups = job.group ? [job.group] : [];
  const held = new Map<string, () => void>();
  return withGroups(groups, async () => {
    const now = ctx.now ?? (() => new Date());
    const logPath = job.logFile
      ? join(ctx.repoRoot, job.logFile)
      : join(ctx.logDir, job.id, `${istDay(now())}.log`);
    const dir = dirname(logPath);
    const cwd = join(ctx.repoRoot, job.cwd);

    // The row goes in first: waiting for the group is then ordered by id, and a crash
    // while waiting or running leaves a row that reapDead can close.
    const runId = ctx.history.start(job.id, trigger, scheduledFor, logPath, now());
    /**
     * A chain step's group: in-process first, then other processes' open rows. Null = held now. The
     * chain lets it go after the last step that needs it (`release`), not at its end.
     */
    const acquire = async (group: string): Promise<string | null> => {
      if (held.has(group)) return null;
      held.set(group, await acquireGroup(group));
      ctx.history.holdRunGroup(runId, group);
      const blocked = await waitForGroup(job, [group], runId, ctx, now, false);
      if (blocked) release(group);
      return blocked;
    };
    const release = (group: string): void => {
      const letGo = held.get(group);
      if (!letGo) return;
      held.delete(group);
      ctx.history.releaseRunGroup(runId, group);
      letGo();
    };
    let fd: number | null = null;
    let result = { code: 1, error: null as string | null };
    let attempts = 0;
    try {
      mkdirSync(dir, { recursive: true });
      const blocked = await waitForGroup(job, groups, runId, ctx, now);
      if (blocked) {
        ctx.history.finish(runId, 1, 0, now(), blocked);
        return { runId, ok: false, exitCode: 1, attempts: 0, logPath, error: blocked };
      }
      fd = openSync(logPath, 'a');
      const logFd = fd;
      if (job.chain) {
        if (options.from && !job.chain.some((step) => step.id === options.from)) {
          const error = `unknown step '${options.from}'. Steps: ${job.chain.map((step) => step.id).join(', ')}`;
          ctx.history.finish(runId, 2, 0, now(), error);
          return { runId, ok: false, exitCode: 2, attempts: 0, logPath, error };
        }
        const unknown = (options.only ?? []).filter(
          (id) => !job.chain?.some((step) => step.id === id),
        );
        if (unknown.length > 0 || options.only?.length === 0) {
          const error = `unknown step(s) '${unknown.join("', '")}'. Steps: ${job.chain.map((step) => step.id).join(', ')}`;
          ctx.history.finish(runId, 2, 0, now(), error);
          return { runId, ok: false, exitCode: 2, attempts: 0, logPath, error };
        }
        // The loop restarting a slot whose run was cut off resumes it on its own (the slot has
        // earlier rows); a hand run resumes only when asked, from the runs of today. What each step
        // last came to across those runs decides (`priorSteps`), so a refused resume or an Apply now
        // never hides a step that passed.
        let prior: Map<string, StepRow> | null = null;
        if (!options.fresh && !options.only) {
          if (scheduledFor) prior = ctx.history.priorSteps(job.id, runId, { slot: scheduledFor });
          else if (options.resume || options.from)
            prior = ctx.history.priorSteps(job.id, runId, {
              since: istAt(istDay(now()), '00:00'),
            });
        }
        writeSync(
          logFd,
          `\n=== ${job.id} · ${trigger}${prior && prior.size > 0 ? ' · resuming' : ''} · ${formatIst(now())} IST\n`,
        );
        const chained: ChainResult = await runChain(job, job.chain, ctx, runId, logFd, now, {
          prior,
          from: options.from,
          only: options.only,
          acquire,
          release,
        });
        writeSync(logFd, `=== exit ${chained.code}\n`);
        ctx.history.finish(runId, chained.code, 1, now(), chained.error);
        return {
          runId,
          ok: chained.code === 0,
          exitCode: chained.code,
          attempts: 1,
          logPath,
          error: chained.error,
          steps: chained.steps,
        };
      }
      for (attempts = 1; attempts <= job.retries + 1; attempts++) {
        // BL-143: the stop button's hold (and BL-140's pause), checked after any wait for the group
        // and before every attempt, whoever started the run (schedule, catch-up, `jobs run`, Apply now).
        const held = heldReason(job.id, ctx.env) ?? pausedReason(job.id, ctx.env, now());
        if (held) {
          writeSync(logFd, `\n=== ${job.id} · ${trigger} · ${formatIst(now())} IST: ${held}\n`);
          const tried = attempts - 1;
          if (tried === 0) {
            ctx.history.finish(runId, 0, 0, now(), held);
            return { runId, ok: true, exitCode: 0, attempts: 0, logPath, error: held };
          }
          // held before a retry: the earlier attempt's failure stays the run's result
          const error = `${result.error ?? `exit ${result.code}`}; retry ${held}`;
          ctx.history.finish(runId, result.code, tried, now(), error);
          return { runId, ok: false, exitCode: result.code, attempts: tried, logPath, error };
        }
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
          result = await runStep(step, cwd, ctx.env, logFd, job.timeoutMinutes * 60_000, (pgid) =>
            ctx.history.setChild(runId, pgid),
          );
          if (result.error) writeSync(logFd, `! ${result.error}\n`);
          if (result.code !== 0) break;
        }
        writeSync(logFd, `=== exit ${result.code}\n`);
        if (result.code === 0 || attempts > job.retries) break;
        // A failure a retry cannot fix (a refused login, a conflict the owner must look at).
        if (job.noRetryExitCodes?.includes(result.code)) break;
        await sleep(job.retryDelayMinutes * 60_000);
      }
    } catch (error) {
      // Never throw: say what happened and close the row so it cannot block its group.
      const message = error instanceof Error ? error.message : String(error);
      ctx.history.finish(runId, 1, attempts, now(), message);
      return { runId, ok: false, exitCode: 1, attempts, logPath, error: message };
    } finally {
      for (const group of [...held.keys()]) release(group);
      if (fd !== null) closeSync(fd);
    }
    attempts = Math.min(attempts, job.retries + 1);
    const error = result.code === 0 ? null : (result.error ?? `exit ${result.code}`);
    ctx.history.finish(runId, result.code, attempts, now(), error);
    return { runId, ok: result.code === 0, exitCode: result.code, attempts, logPath, error };
  });
}
