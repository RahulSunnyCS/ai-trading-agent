import { type AlertSink, alertMissed, alertResult } from './alerts.js';
import type { History } from './history.js';
import type { Job } from './jobs.js';
import { type RunContext, runJob } from './runner.js';
import { formatIst, istDay, previousDue } from './schedule.js';

/** A slot started within this long of its time counts as on time, not a catch-up. */
const ON_TIME_MS = 5 * 60_000;

export type Decision =
  | { kind: 'idle' }
  | { kind: 'run'; slot: Date; trigger: 'schedule' | 'catch-up' }
  | { kind: 'missed'; slot: Date; lateByMs: number };

/**
 * What to do about a job right now. Driven entirely by the run history, so a
 * laptop that slept through a slot simply finds it unserved on the next tick —
 * no separate wake detection is needed.
 */
export function decide(job: Job, now: Date, history: History, firstStart: Date): Decision {
  const slot = previousDue(job.schedule, now);
  if (!slot || slot.getTime() < firstStart.getTime()) return { kind: 'idle' };
  if (history.forSlot(job.id, slot)) return { kind: 'idle' };
  const late = now.getTime() - slot.getTime();
  if (late <= ON_TIME_MS) return { kind: 'run', slot, trigger: 'schedule' };
  if (late <= job.catchUpHours * 3_600_000) return { kind: 'run', slot, trigger: 'catch-up' };
  return { kind: 'missed', slot, lateByMs: late };
}

/**
 * Today's slots that have already passed with no run recorded. Slots before the
 * scheduler's first start are never run (they belonged to whatever scheduled the job
 * before), so this is what a fresh install tells the owner to run by hand.
 */
export function skippedToday(
  jobs: Job[],
  now: Date,
  history: History,
): Array<{ job: Job; slot: Date }> {
  const today = istDay(now);
  const out: Array<{ job: Job; slot: Date }> = [];
  for (const job of jobs) {
    if (job.builtin) continue; // the morning summary needs no catch-up
    const slot = previousDue(job.schedule, now);
    if (slot && istDay(slot) === today && !history.forSlot(job.id, slot)) out.push({ job, slot });
  }
  return out;
}

export interface LoopOptions {
  ctx: RunContext;
  jobs: Job[];
  alerts: AlertSink;
  tickMs?: number;
}

/**
 * The long-running scheduler: every tick, decide for each job; start what is
 * due (without waiting for it), report what was missed. A job already in
 * flight in this process is never started twice.
 */
export function startLoop({ ctx, jobs, alerts, tickMs = 30_000 }: LoopOptions): () => void {
  const now = ctx.now ?? (() => new Date());
  const firstStart = ctx.history.firstStart(now());
  const inFlight = new Set<string>();

  const tick = () => {
    for (const job of jobs) {
      if (inFlight.has(job.id)) continue;
      try {
        handle(job);
      } catch (error) {
        // A bookkeeping failure (say a locked database) must not take the whole scheduler down.
        console.error(`${job.id}: tick failed: ${String(error)}`);
      }
    }
  };

  const handle = (job: Job) => {
    const decision = decide(job, now(), ctx.history, firstStart);
    if (decision.kind === 'missed') {
      const reason = `missed: the scheduler was not running at ${formatIst(decision.slot)} IST`;
      ctx.history.recordMissed(job.id, decision.slot, now(), reason);
      void alertMissed(alerts, job, decision.slot);
    } else if (decision.kind === 'run') {
      inFlight.add(job.id);
      console.log(`${formatIst(now())} start ${job.id} (${decision.trigger})`);
      runJob(job, ctx, decision.trigger, decision.slot)
        .then(async (result) => {
          console.log(`${formatIst(now())} ${job.id}: ${result.ok ? 'ok' : result.error}`);
          await alertResult(alerts, job, result, ctx.history);
        })
        .catch((error: unknown) => console.error(`${job.id}: ${String(error)}`))
        .finally(() => inFlight.delete(job.id));
    }
  };

  tick();
  const timer = setInterval(tick, tickMs);
  return () => clearInterval(timer);
}
