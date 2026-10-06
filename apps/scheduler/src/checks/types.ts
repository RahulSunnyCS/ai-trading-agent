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
