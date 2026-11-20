import type { ChainStep, Job } from './jobs.js';
import { pausedReason } from './pause.js';
import { istAt, istDay } from './schedule.js';
import { heldReason } from './stop-hold.js';

/**
 * BL-234 Phase 4: `jobs run <chain> --dry-run [--at HH:MM]` prints what a chain would do, in order,
 * with every wait, hold and "too late" skip, and runs nothing: no process is started, no login made,
 * no run or step row written, no log opened. The clock is virtual: a step is taken as instant, so the
 * only time that passes is a step's `notBefore` wait. A chain really takes each step's duration, so a
 * step that is near its `notAfter` in this plan may be past it in a real run.
 *
 * It reads the same holds a real run does (the stop button's, the settings pause), so the plan of a
 * morning with a pause on shows the held steps.
 */

export interface PlanLine {
  /** the virtual clock when the step is reached */
  at: Date;
  step: string;
  /** what the chain does at this step */
  action: 'run' | 'wait' | 'late' | 'held' | 'skipped';
  text: string;
}

export interface PlanOptions {
  /** where the virtual clock starts (default: now) */
  start?: Date;
  env?: Record<string, string>;
}

const describe = (step: ChainStep): string => {
  const parts = [
    step.argv.join(' '),
    `timeout ${step.timeoutMinutes ?? '?'} min`,
    step.retries
      ? `${step.retries} retries ${step.retryDelayMinutes ?? 0} min apart`
      : 'no retries',
    step.group ? `group ${step.group}` : null,
    `on failure: ${(step.onFail ?? 'stop') === 'stop' ? 'ends the chain' : 'carries on'}`,
  ];
  return parts.filter(Boolean).join(' · ');
};

export function planChain(job: Job, options: PlanOptions = {}): PlanLine[] {
  const chain = job.chain ?? [];
  const env = options.env ?? {};
  let clock = options.start ?? new Date();
  const lines: PlanLine[] = [];
  // 'ok' = would run and pass; 'held' = held or late (a step that requires it is held too)
  const state = new Map<string, 'ok' | 'held'>();
  for (const step of chain) {
    const push = (action: PlanLine['action'], text: string) =>
      lines.push({ at: clock, step: step.id, action, text });
    const day = istDay(clock);
    const missing = (step.requires ?? []).filter((id) => state.get(id) !== 'ok');
    if (missing.length > 0) {
      push('held', `not run: ${missing.join(', ')} would not pass`);
      state.set(step.id, 'held');
      continue;
    }
    const heldNow = step.holdId
      ? (heldReason(step.holdId, env) ?? pausedReason(step.holdId, env, clock))
      : null;
    if (heldNow) {
      push('held', heldNow);
      state.set(step.id, 'held');
      continue;
    }
    if (step.notAfter && clock.getTime() > istAt(day, step.notAfter).getTime()) {
      push(
        'late',
        `too late: ${step.notAfter} IST has passed${step.alertLate ? ' (named in the alert)' : ''}`,
      );
      state.set(step.id, 'held');
      continue;
    }
    if (step.notBefore) {
      const until = istAt(day, step.notBefore);
      const minutes = Math.ceil((until.getTime() - clock.getTime()) / 60_000);
      if (minutes > 0) {
        push('wait', `waits ${minutes} min for ${step.notBefore} IST`);
        clock = until;
      }
    }
    push('run', describe(step));
    state.set(step.id, 'ok');
  }
  return lines;
}

/** The plan as the lines the CLI prints. */
export function renderPlan(job: Job, lines: PlanLine[]): string[] {
  const clock = (d: Date) =>
    d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
  return [
    `${job.id}: dry run, nothing is started (steps taken as instant; the only time that passes is a wait)`,
    ...lines.map((l) => `  ${clock(l.at)}  ${l.step.padEnd(24)} ${l.action.padEnd(7)} ${l.text}`),
  ];
}
