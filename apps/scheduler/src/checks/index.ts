import type { Job } from '../jobs.js';
import type { Builtin } from '../runner.js';
import { tradingDays } from '../schedule.js';
import * as calendar from './calendar.js';
import * as credentials from './credentials.js';
import * as digest from './digest.js';
import * as drift from './drift.js';
import * as stock from './stock.js';
import { type SuiteMember, checkJob, checkSuite } from './types.js';

/**
 * One module per group so parallel PRs never edit the same lines. A module exports
 * `jobs` (the schedule entries) and `builtins` (id → function).
 */
const MODULES = [drift, calendar, stock, credentials, digest];

const MODULE_JOBS: Job[] = MODULES.flatMap((m) => m.jobs);

/**
 * BL-234: the daily alert-only checks run as two suites, not nine jobs. A check named here stays
 * defined in its module (its description, fix hint and retries are read from there) but is not
 * scheduled on its own; its suite runs it. A check that only fires on its own day (the monthly
 * margin reminder, the yearly credential rotation) or does real work (the digest) stays a job.
 */
const SUITES: Array<{
  id: string;
  description: string;
  at: string;
  members: string[];
}> = [
  {
    id: 'morning-checks',
    description: 'The morning alert-only checks, run together',
    at: '08:30',
    members: [
      'check-nifty50-membership',
      'calendar-upkeep',
      'check-blocked-dates',
      'gh-auth-check',
      'universe-refresh-reminder',
      'check-stock-ca-baseline-age',
      'check-stock-review-queue',
    ],
  },
  {
    id: 'evening-checks',
    description: 'The evening alert-only checks on the exchange reference data, run together',
    at: '17:00',
    members: ['check-lot-sizes', 'check-expiry-calendar'],
  },
];

const MERGED = new Set(SUITES.flatMap((s) => s.members));

function memberJob(id: string): Job {
  const job = MODULE_JOBS.find((j) => j.id === id);
  if (!job?.builtin) throw new Error(`check suite member '${id}' is not a check job`);
  return job;
}

function suiteJob(suite: (typeof SUITES)[number]): Job {
  const members = suite.members.map(memberJob);
  // A member that retries (a network blip) is retried alone inside the suite, so the whole run
  // lasts as long as the slowest member's attempts and delays.
  const longest = Math.max(
    ...members.map((j) => j.timeoutMinutes * (j.retries + 1) + j.retryDelayMinutes * j.retries),
  );
  return checkJob({
    id: suite.id,
    description: `${suite.description} (${suite.members.join(', ')})`,
    schedule: { at: suite.at, on: tradingDays, label: `trading days ${suite.at}` },
    builtin: suite.id,
    timeoutMinutes: longest,
    needs: [...new Set(members.flatMap((j) => j.needs ?? []))],
    fixHint: `Each problem in the alert names its own fix; the log has a line for every check. Run it again with: bun run --filter @ata/scheduler jobs run ${suite.id}`,
  });
}

/** What a member was as a job of its own, for the suite to run and to alert with. */
function suiteMember(id: string): SuiteMember {
  const job = memberJob(id);
  return {
    id,
    builtin: job.builtin as string,
    fixHint: job.fixHint,
    retries: job.retries,
    retryDelayMinutes: job.retryDelayMinutes,
  };
}

export const CHECK_JOBS: Job[] = [
  ...MODULE_JOBS.filter((j) => !MERGED.has(j.id)),
  ...SUITES.map(suiteJob),
];

const MODULE_BUILTINS: Record<string, Builtin> = Object.assign(
  {},
  ...MODULES.map((m) => m.builtins),
);

export const CHECK_BUILTINS: Record<string, Builtin> = {
  ...MODULE_BUILTINS,
  ...Object.fromEntries(
    SUITES.map((s) => [s.id, checkSuite(s.members.map(suiteMember), () => MODULE_BUILTINS)]),
  ),
};
