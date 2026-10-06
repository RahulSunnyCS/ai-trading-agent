import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Job } from '../jobs.js';
import type { Builtin, BuiltinContext } from '../runner.js';
import { tradingDays } from '../schedule.js';
import { type CheckResult, checkBuiltin, checkJob } from './types.js';

/**
 * Stock-data deadlines (BL-012 inventory M2 and W3). Both read the output of the read-only
 * `mbt stocks deadlines` command, so the age rule lives in one place (`adjust.diff_ca_events`
 * + `guards.check_ca_diff_age`) and nothing here opens DuckDB or writes anything.
 */

/** `check_ca_diff_age` fails the Friday `mbt stocks sync` above this many days. */
export const CA_DIFF_FAIL_DAYS = 30;
/** Warn this many days in, leaving ten days to review before the sync starts failing. */
export const CA_DIFF_WARN_DAYS = 20;

export const REVIEW_LINK = 'http://127.0.0.1:5190/momentum/weekly';

export interface DeadlinesReport {
  ca_diff:
    | { error: string }
    | {
        baseline: boolean;
        events: Array<{
          company_id: string;
          ex_date: string;
          change: string;
          age_days: number;
          detail: string;
        }>;
      }
    | null;
  reviews: { error: string } | { pending_count: number; manual_review_after: string } | null;
}

export type DeadlinesReader = (ctx: BuiltinContext) => Promise<DeadlinesReport>;

/** Run `uv run mbt stocks deadlines` in the momentum package and parse its JSON line. */
export const readDeadlines: DeadlinesReader = (ctx) =>
  new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const child = spawn('uv', ['run', 'mbt', 'stocks', 'deadlines'], {
      cwd: join(ctx.repoRoot, 'packages/momentum-backtesting'),
      env: ctx.env,
    });
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`mbt stocks deadlines exited ${code}: ${err.trim()}`));
      }
      try {
        resolve(JSON.parse(out.trim().split('\n').pop() ?? '') as DeadlinesReport);
      } catch {
        reject(new Error(`mbt stocks deadlines printed no JSON: ${out.trim().slice(0, 200)}`));
      }
    });
  });

export function evaluateCaAge(report: DeadlinesReport): CheckResult {
  const ca = report.ca_diff;
  if (!ca) return { ok: false, detail: 'corporate-action baseline: the helper returned nothing' };
  if ('error' in ca) {
    return { ok: false, detail: `corporate-action baseline could not be checked: ${ca.error}` };
  }
  if (!ca.baseline) return { ok: true, detail: 'corporate-action baseline: none pinned yet' };
  if (ca.events.length === 0) {
    return { ok: true, detail: 'corporate-action baseline: no un-pinned corporate-action changes' };
  }
  const oldest = Math.max(...ca.events.map((e) => e.age_days));
  const list = ca.events
    .slice(0, 5)
    .map((e) => `${e.company_id} ${e.ex_date} (${e.change}, ${e.age_days} d)`)
    .join('; ');
  const more = ca.events.length > 5 ? ` and ${ca.events.length - 5} more` : '';
  if (oldest >= CA_DIFF_WARN_DAYS) {
    const state =
      oldest > CA_DIFF_FAIL_DAYS
        ? 'the Friday stock sync is already failing on it'
        : `the Friday stock sync starts failing after ${CA_DIFF_FAIL_DAYS} days`;
    return {
      ok: false,
      detail: `${ca.events.length} corporate-action change(s) not yet reviewed, oldest ${oldest} days old; ${state}. ${list}${more}`,
    };
  }
  return {
    ok: true,
    detail: `corporate-action baseline: ${ca.events.length} change(s) awaiting review, oldest ${oldest} d (warns at ${CA_DIFF_WARN_DAYS})`,
  };
}

export function evaluateReviews(report: DeadlinesReport): CheckResult {
  const r = report.reviews;
  if (!r) return { ok: false, detail: 'stock-action reviews: the helper returned nothing' };
  if ('error' in r) {
    return { ok: false, detail: `stock-action reviews could not be read: ${r.error}` };
  }
  if (r.pending_count === 0) return { ok: true, detail: 'stock-action reviews: nothing to review' };
  return {
    ok: false,
    detail: `${r.pending_count} events to review (split/bonus candidates since ${r.manual_review_after}): ${REVIEW_LINK}`,
  };
}

export function caAgeCheck(read: DeadlinesReader = readDeadlines): Builtin {
  return checkBuiltin(async (ctx) => evaluateCaAge(await read(ctx)));
}

export function reviewQueueCheck(read: DeadlinesReader = readDeadlines): Builtin {
  return checkBuiltin(async (ctx) => evaluateReviews(await read(ctx)));
}

export const jobs: Job[] = [
  checkJob({
    id: 'check-stock-ca-baseline-age',
    description: 'Warn when a corporate-action change has waited 20+ days for review (M2)',
    schedule: { at: '08:40', on: tradingDays, label: 'trading days 08:40' },
    builtin: 'check-stock-ca-baseline-age',
    fixHint:
      'cd packages/momentum-backtesting && uv run mbt stocks fetch  # review data/stocks/fetch_report.csv, then: uv run mbt stocks pin-manifest  (or fetch --accept-ca-diff reviewed.csv)',
  }),
  checkJob({
    id: 'check-stock-review-queue',
    description: 'Count split/bonus candidates awaiting review in the dashboard (W3)',
    schedule: { at: '08:40', on: tradingDays, label: 'trading days 08:40' },
    builtin: 'check-stock-review-queue',
    fixHint: `Review them in the dashboard: ${REVIEW_LINK} (Data health · stock action reviews)`,
  }),
];

export const builtins: Record<string, Builtin> = {
  'check-stock-ca-baseline-age': caAgeCheck(),
  'check-stock-review-queue': reviewQueueCheck(),
};
