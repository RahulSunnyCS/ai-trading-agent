import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StepRow, StepStatus } from './history.js';
import type { ChainStep, Job } from './jobs.js';
import { pausedReason } from './pause.js';
import type { RunContext } from './runner.js';
import { formatIst, istAt, istDay } from './schedule.js';
import { runStep } from './step.js';
import { heldReason } from './stop-hold.js';

/**
 * BL-234: running a job's `chain`. Each step starts when the one before ends and carries its own
 * timeout, retries, failure policy, alert, log file and hold. The run records every step in
 * `run_steps`, which is what lets a later run resume where this one stopped.
 */

/** What one step came to, for the run's result and its alert. */
export interface StepOutcome {
  id: string;
  status: StepStatus;
  exitCode: number | null;
  attempts: number;
  error: string | null;
  alertsItself: boolean;
  /** A `late` outcome that the alert names (`ChainStep.alertLate`). */
  alertLate?: boolean;
  fixHint: string;
}

export interface ChainOptions {
  /**
   * What each step last came to in the runs this one resumes (`History.priorSteps`): the ones that
   * passed are not run again, one that was cut off mid-run stops the resume.
   */
  prior?: Map<string, StepRow> | null | undefined;
  /** Start at this step: every step before it counts as already done. */
  from?: string | undefined;
  /** Run only these steps; the others are left out of the run and count as done. */
  only?: string[] | undefined;
  /**
   * Takes a step's group when the chain gets to it, and holds it to the end. Resolves with why it could
   * not (another job holds it past the wait), or null.
   */
  acquire?: ((group: string) => Promise<string | null>) | undefined;
  /** Lets a group go once no later step needs it, so another job need not wait for the chain's end. */
  release?: ((group: string) => void) | undefined;
}

export interface ChainResult {
  code: number;
  error: string | null;
  steps: StepOutcome[];
}

/** Exit code of a run that refused to resume over a step that may already have done its work. */
export const UNKNOWN_STEP = 4;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type State = 'ok' | 'failed' | 'skipped' | 'held';

export async function runChain(
  job: Job,
  chain: ChainStep[],
  ctx: RunContext,
  runId: number,
  logFd: number,
  now: () => Date,
  options: ChainOptions = {},
): Promise<ChainResult> {
  const history = ctx.history;
  const sleep = ctx.sleep ?? defaultSleep;
  const log = (text: string) => writeSync(logFd, `${text}\n`);
  const prior = options.prior ?? new Map<string, StepRow>();
  const fromIndex = options.from ? chain.findIndex((s) => s.id === options.from) : -1;

  // A step that was running when the last run was cut off may have done its work (a login sent, an
  // algo enabled): resuming never repeats it unasked. `--from <step>` runs it, `--from <next>` skips it.
  for (const [i, step] of chain.entries()) {
    if (fromIndex >= 0 && i <= fromIndex) continue; // `--from` runs its own step on purpose
    const before = prior.get(step.id);
    if (before && (before.status === 'running' || before.status === 'unknown')) {
      const error = `${step.id} was running when run ${before.run_id} was cut off, so it may already have done its work. Check by hand, then run again with --from ${step.id} (run it) or --from <the step after> (skip it)`;
      log(`! ${error}`);
      return { code: UNKNOWN_STEP, error, steps: [] };
    }
  }

  const state = new Map<string, State>();
  const outcomes: StepOutcome[] = [];
  let endedBy: string | null = null;

  const note = (
    step: ChainStep,
    status: StepStatus,
    exitCode: number | null,
    attempts: number,
    error: string | null,
  ) =>
    outcomes.push({
      id: step.id,
      status,
      exitCode,
      attempts,
      error,
      alertsItself: step.alertsItself ?? false,
      ...(step.alertLate ? { alertLate: true } : {}),
      fixHint: step.fixHint,
    });

  // The last step that needs each group among those that run: after it the group is let go.
  const lastUse = new Map<string, number>();
  for (const [i, step] of chain.entries())
    if (step.group && (!options.only || options.only.includes(step.id))) lastUse.set(step.group, i);
  const holding = new Set<string>();

  for (const [i, step] of chain.entries()) {
    for (const group of [...holding]) {
      if ((lastUse.get(group) ?? -1) < i) {
        holding.delete(group);
        options.release?.(group);
        log(`· ${group} group let go: no later step needs it`);
      }
    }
    // not picked (Apply now runs one platform's steps): left out, and counted as done so the steps
    // that require it still run
    if (options.only && !options.only.includes(step.id)) {
      state.set(step.id, 'ok');
      continue;
    }
    // earlier than --from: the owner says it is done
    if (i < fromIndex) {
      history.recordStep(runId, step.id, 'carried', now(), `before --from ${options.from}`);
      state.set(step.id, 'ok');
      note(step, 'carried', 0, 0, null);
      continue;
    }
    // passed in the run this one resumes
    const before = prior.get(step.id);
    if (before && (before.status === 'ok' || before.status === 'carried')) {
      history.recordStep(
        runId,
        step.id,
        'carried',
        now(),
        null,
        before.carried_from ?? before.run_id,
      );
      state.set(step.id, 'ok');
      note(step, 'carried', 0, 0, null);
      log(`· ${step.id}: passed in run ${before.carried_from ?? before.run_id}, not run again`);
      continue;
    }
    if (endedBy) {
      const reason = `not run: ${endedBy} failed and ends the chain`;
      history.recordStep(runId, step.id, 'skipped', now(), reason);
      state.set(step.id, 'skipped');
      note(step, 'skipped', null, 0, reason);
      log(`· ${step.id}: ${reason}`);
      continue;
    }
    const missing = (step.requires ?? []).filter((id) => state.get(id) !== 'ok');
    if (missing.length > 0) {
      const heldBehind = missing.some((id) => state.get(id) === 'held');
      const reason = heldBehind
        ? `held: ${missing.join(', ')} was held`
        : `skipped: ${missing.join(', ')} did not pass`;
      const status: StepStatus = heldBehind ? 'held' : 'skipped';
      history.recordStep(runId, step.id, status, now(), reason);
      state.set(step.id, heldBehind ? 'held' : 'skipped');
      note(step, status, heldBehind ? 0 : null, 0, reason);
      log(`· ${step.id}: ${reason}`);
      continue;
    }
    const held = () =>
      step.holdId
        ? (heldReason(step.holdId, ctx.env) ?? pausedReason(step.holdId, ctx.env, now()))
        : null;
    const heldNow = held();
    if (heldNow) {
      history.recordStep(runId, step.id, 'held', now(), heldNow);
      state.set(step.id, 'held');
      note(step, 'held', 0, 0, heldNow);
      log(`· ${step.id}: ${heldNow}`);
      continue;
    }

    // started too late to be worth running (a laptop that slept through it): not a failure. Checked
    // again after the `notBefore` wait and after the group wait, which can take a long time (a Mac
    // that sleeps through the 08:16 wait must not start a login hours late).
    const tooLate = () =>
      step.notAfter && now().getTime() > istAt(istDay(now()), step.notAfter).getTime()
        ? `too late: ${step.notAfter} IST has passed`
        : null;
    const lateNow = (reason: string, rowId: number | null) => {
      if (rowId === null) history.recordStep(runId, step.id, 'late', now(), reason);
      else history.finishStep(rowId, 'late', 0, 0, now(), reason);
      state.set(step.id, 'held');
      note(step, 'late', 0, 0, reason);
      log(`· ${step.id}: ${reason}`);
    };
    const lateBefore = tooLate();
    if (lateBefore) {
      lateNow(lateBefore, null);
      continue;
    }

    if (step.notBefore) {
      const wait = istAt(istDay(now()), step.notBefore).getTime() - now().getTime();
      if (wait > 0) {
        log(`· ${step.id}: waiting for ${step.notBefore} IST`);
        await sleep(wait);
        const lateAfterWait = tooLate();
        if (lateAfterWait) {
          lateNow(lateAfterWait, null);
          continue;
        }
      }
    }

    const rowId = history.startStep(runId, step.id, now());
    const blocked = step.group && options.acquire ? await options.acquire(step.group) : null;
    if (step.group && !blocked) holding.add(step.group);
    if (blocked) {
      history.finishStep(rowId, 'failed', 1, 0, now(), blocked);
      state.set(step.id, 'failed');
      note(step, 'failed', 1, 0, blocked);
      log(`· ${step.id}: failed (${blocked})`);
      if ((step.onFail ?? 'stop') === 'stop') endedBy = step.id;
      continue;
    }
    const lateAfterGroup = tooLate();
    if (lateAfterGroup) {
      lateNow(lateAfterGroup, rowId);
      continue;
    }
    const retries = step.retries ?? 0;
    const timeoutMs = (step.timeoutMinutes ?? job.timeoutMinutes) * 60_000;
    const cwd = join(ctx.repoRoot, step.cwd ?? job.cwd);
    let stepFd = logFd;
    if (step.logFile) {
      const path = join(ctx.repoRoot, step.logFile);
      mkdirSync(dirname(path), { recursive: true });
      stepFd = openSync(path, 'a');
    }
    let result = { code: 1, error: null as string | null };
    let attempts = 0;
    try {
      for (attempts = 1; attempts <= retries + 1; attempts++) {
        // the stop button may have been pressed since the first attempt
        const heldRetry = attempts > 1 ? held() : null;
        if (heldRetry) {
          result = {
            code: result.code,
            error: `${result.error ?? `exit ${result.code}`}; retry ${heldRetry}`,
          };
          break;
        }
        writeSync(
          stepFd,
          `\n=== ${job.id}/${step.id} · attempt ${attempts} · ${formatIst(now())} IST\n$ ${step.argv.join(' ')}\n`,
        );
        result = await runStep(step.argv, cwd, ctx.env, stepFd, timeoutMs, (pgid) =>
          history.setChild(runId, pgid),
        );
        if (result.error) writeSync(stepFd, `! ${result.error}\n`);
        writeSync(stepFd, `=== exit ${result.code}\n`);
        if (result.code === 0 || attempts > retries) break;
        if (step.noRetryExitCodes?.includes(result.code)) break;
        await sleep((step.retryDelayMinutes ?? 0) * 60_000);
      }
    } finally {
      if (stepFd !== logFd) closeSync(stepFd);
      history.setChild(runId, null);
    }
    attempts = Math.min(attempts, retries + 1);
    if (result.code === 0) {
      history.finishStep(rowId, 'ok', 0, attempts, now());
      state.set(step.id, 'ok');
      note(step, 'ok', 0, attempts, null);
      log(`· ${step.id}: ok`);
    } else {
      const error = result.error ?? `exit ${result.code}`;
      history.finishStep(rowId, 'failed', result.code, attempts, now(), error);
      state.set(step.id, 'failed');
      note(step, 'failed', result.code, attempts, error);
      log(`· ${step.id}: failed (${error})`);
      if ((step.onFail ?? 'stop') === 'stop') endedBy = step.id;
    }
  }

  const problems = outcomes.filter(
    (o) => o.status === 'failed' || o.status === 'skipped' || (o.status === 'late' && o.alertLate),
  );
  if (problems.length === 0) return { code: 0, error: null, steps: outcomes };
  const first = problems.find((o) => o.status === 'failed');
  return {
    code: first?.exitCode ?? 1,
    error: problems.map((o) => `${o.id}: ${o.error ?? `exit ${o.exitCode}`}`).join('; '),
    steps: outcomes,
  };
}
