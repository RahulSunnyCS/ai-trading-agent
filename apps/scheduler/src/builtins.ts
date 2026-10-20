import { backupJob } from './backup.js';
import { CHECK_BUILTINS } from './checks/index.js';
import type { Builtin } from './runner.js';
import { withStopOffer } from './stop-button.js';
import { morningSummary } from './summary.js';

/** Every in-process job, by `Job.builtin` id. */
export function allBuiltins(): Record<string, Builtin> {
  return {
    // BL-143: the morning message is followed by the stop button's offer when STOP_BUTTON=on
    'morning-summary': withStopOffer(morningSummary()),
    backup: backupJob(),
    ...CHECK_BUILTINS,
  };
}
