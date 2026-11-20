import type { Job } from '../jobs.js';
import type { Builtin, BuiltinContext } from '../runner.js';

/**
 * A check looks for a slow-burning problem and says so; it never changes data (BL-012:
 * alert only). A problem makes the job exit 1 with the detail as its error, so the
 * scheduler's ordinary failure alert fires with the job's `fixHint`. Because the job runs
 * every day, an unfixed problem repeats once a day — the "at most daily" noise rule.
 */
export interface CheckResult {
  ok: boolean;
  /** One line: what was checked and what was found. */
  detail: string;
}

export function checkBuiltin(
  fn: (ctx: BuiltinContext) => Promise<CheckResult> | CheckResult,
): Builtin {
  return async (ctx) => {
    const result = await fn(ctx);
    ctx.log(`${result.ok ? 'ok' : 'PROBLEM'}: ${result.detail}`);
    return result.ok ? { code: 0, error: null } : { code: 1, error: result.detail };
  };
}

type CheckJobInput = Pick<Job, 'id' | 'description' | 'schedule' | 'builtin' | 'fixHint'> &
  Partial<Job>;

/** A check job with the defaults checks share: in-process, quick, no retries, 24 h catch-up. */
export function checkJob(input: CheckJobInput): Job {
  return {
    steps: [],
    cwd: '.',
    timeoutMinutes: 5,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 24,
    ...input,
  };
}

/** One check inside a suite (BL-234): what it was as a job of its own. */
export interface SuiteMember {
  id: string;
  /** The `Job.builtin` id of the check's function. */
  builtin: string;
  /** Said under this member's problem in the suite's alert, as its own job's alert once did. */
  fixHint: string;
  /** Extra attempts of this check alone (a network blip), `retryDelayMinutes` apart. */
  retries?: number;
  retryDelayMinutes?: number;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs every member in order, never stopping at a problem (BL-234): the checks are independent and
 * alert-only, so one that finds something must not hide the rest. A member with `retries` that
 * fails is run again alone, after its delay, until it passes or runs out; the others are not
 * run twice. The result is ONE failure naming each problem with its own fix, so a bad morning is
 * one Telegram message, not one per check.
 */
export function checkSuite(
  members: SuiteMember[],
  lookup: () => Record<string, Builtin>,
  sleep: (ms: number) => Promise<void> = sleepMs,
): Builtin {
  return async (ctx) => {
    const builtins = lookup();
    const errors = new Map<string, string>();
    let due = members;
    for (let pass = 0; due.length > 0; pass++) {
      for (const member of due) {
        const fn = builtins[member.builtin];
        let error: string | null;
        if (!fn) error = `builtin '${member.builtin}' is not registered`;
        else {
          try {
            const result = await fn({ ...ctx, log: (text) => ctx.log(`[${member.id}] ${text}`) });
            error = result.code === 0 ? null : (result.error ?? `exit ${result.code}`);
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
        }
        if (error) errors.set(member.id, error);
        else errors.delete(member.id);
      }
      const again = members.filter((m) => errors.has(m.id) && (m.retries ?? 0) > pass);
      if (again.length === 0) break;
      const minutes = Math.max(...again.map((m) => m.retryDelayMinutes ?? 0));
      ctx.log(`retrying ${again.map((m) => m.id).join(', ')} in ${minutes} min`);
      await sleep(minutes * 60_000);
      due = again;
    }
    if (errors.size === 0) return { code: 0, error: null };
    const lines = members
      .filter((m) => errors.has(m.id))
      .map((m) => `• ${m.id}: ${errors.get(m.id)}\n  Fix: ${m.fixHint}`);
    return {
      code: 1,
      error: `${errors.size} of ${members.length} checks found a problem\n${lines.join('\n')}`,
    };
  };
}
