import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from '../jobs.js';
import type { Builtin, BuiltinContext } from '../runner.js';
import { istDay, tradingDays } from '../schedule.js';
import { type CheckResult, checkBuiltin, checkJob } from './types.js';

/**
 * Stock-data deadlines (BL-012 inventory M2, W3 and S3). M2 and W3 read the output of the
 * read-only `mbt stocks deadlines` command, so the age rule lives in one place
 * (`adjust.diff_ca_events` + `guards.check_ca_diff_age`) and nothing here opens DuckDB or
 * writes anything. S3 reads the category files' dates and years.
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

/**
 * BL-012 inventory S3: Broad Momentum's Total Market universe and the sector/thematic category
 * membership are fetched by hand (`mbt categories fetch-universe`, `mbt categories fetch`) and
 * go stale at each NSE semi-annual index review, which takes effect at the end of March and of
 * September. From 1 Apr and 1 Oct the file must have been rewritten since, and from 1 Jan it
 * must hold the new year's rows. The files carry no fetch date, so "refreshed" is the file's
 * modification day (IST); a copy that resets it can only hide a due refresh, never invent one.
 */
export const UNIVERSE_FILES = [
  { file: 'total_market_membership.csv', label: 'Total Market universe' },
  { file: 'category_membership.csv', label: 'category membership' },
] as const;

export interface UniverseFile {
  /** IST day the file was last written. */
  refreshedDay: string;
  /** Highest `year` in the file, or null when it has no rows. */
  newestYear: number | null;
}

/** Reads `<momentum data>/categories/<file>`; null when the file does not exist. */
export type UniverseReader = (file: string) => UniverseFile | null;

export function diskUniverseReader(dataDir: string): UniverseReader {
  return (file) => {
    const path = join(dataDir, 'categories', file);
    let text: string;
    let mtime: Date;
    try {
      mtime = statSync(path).mtime;
      text = readFileSync(path, 'utf8');
    } catch {
      return null;
    }
    let newestYear: number | null = null;
    for (const line of text.split('\n').slice(1)) {
      const year = Number(line.split(',')[1]);
      if (Number.isInteger(year) && year > 0 && (newestYear === null || year > newestYear)) {
        newestYear = year;
      }
    }
    return { refreshedDay: istDay(mtime), newestYear };
  };
}

/** The latest 1 Apr or 1 Oct on or before `today`: the last index review's due day. */
export function lastReviewDay(today: string): string {
  const year = Number(today.slice(0, 4));
  const candidates = [`${year}-10-01`, `${year}-04-01`, `${year - 1}-10-01`];
  return candidates.find((d) => d <= today) ?? `${year - 1}-10-01`;
}

export function checkUniverseRefresh(today: string, read: UniverseReader): CheckResult {
  const review = lastReviewDay(today);
  const year = Number(today.slice(0, 4));
  const problems: string[] = [];
  const fine: string[] = [];
  for (const { file, label } of UNIVERSE_FILES) {
    const info = read(file);
    if (!info) {
      problems.push(`${label}: ${file} does not exist`);
      continue;
    }
    const issues: string[] = [];
    if (info.refreshedDay < review) {
      issues.push(`last refreshed ${info.refreshedDay}, before the index review due ${review}`);
    }
    if (info.newestYear === null) issues.push('no rows');
    else if (info.newestYear < year) issues.push(`no ${year} rows (newest ${info.newestYear})`);
    if (issues.length > 0) problems.push(`${label} (${file}): ${issues.join(', ')}`);
    else fine.push(`${label} refreshed ${info.refreshedDay}`);
  }
  if (problems.length > 0) {
    return { ok: false, detail: `momentum universe refresh due — ${problems.join('; ')}` };
  }
  return { ok: true, detail: `${fine.join('; ')} (last index review due ${review})` };
}

export function momentumDataDir(ctx: BuiltinContext): string {
  return ctx.env.MOMENTUM_DATA_DIR || join(ctx.repoRoot, 'packages/momentum-backtesting/data');
}

export const jobs: Job[] = [
  checkJob({
    id: 'universe-refresh-reminder',
    description:
      'Remind to refresh the Total Market universe and category membership after each NSE index review (S3)',
    schedule: { at: '08:40', on: tradingDays, label: 'trading days 08:40' },
    builtin: 'universe-refresh-reminder',
    fixHint:
      'On the home connection (NSE): cd packages/momentum-backtesting && uv run mbt categories fetch-universe && uv run mbt categories fetch && uv run mbt local migrate',
  }),
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
  'universe-refresh-reminder': checkBuiltin((ctx) =>
    checkUniverseRefresh(istDay(ctx.now()), diskUniverseReader(momentumDataDir(ctx))),
  ),
};
