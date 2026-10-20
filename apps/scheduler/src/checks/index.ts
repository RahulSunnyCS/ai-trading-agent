import type { Job } from '../jobs.js';
import type { Builtin } from '../runner.js';
import * as calendar from './calendar.js';
import * as credentials from './credentials.js';
import * as digest from './digest.js';
import * as drift from './drift.js';
import * as stock from './stock.js';

/**
 * One module per group so parallel PRs never edit the same lines. A module exports
 * `jobs` (the schedule entries) and `builtins` (id → function).
 */
const MODULES = [drift, calendar, stock, credentials, digest];

export const CHECK_JOBS: Job[] = MODULES.flatMap((m) => m.jobs);
export const CHECK_BUILTINS: Record<string, Builtin> = Object.assign(
  {},
  ...MODULES.map((m) => m.builtins),
);
