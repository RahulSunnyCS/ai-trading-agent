import { backupJob } from './backup.js';
import { CHECK_BUILTINS } from './checks/index.js';
import type { Builtin } from './runner.js';
import { morningSummary } from './summary.js';

/** Every in-process job, by `Job.builtin` id. */
export function allBuiltins(): Record<string, Builtin> {
  return { 'morning-summary': morningSummary(), backup: backupJob(), ...CHECK_BUILTINS };
}
