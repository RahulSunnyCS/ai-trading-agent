import type { Job } from '../jobs.js';
import type { Builtin } from '../runner.js';

// BL-012 checks — see apps/scheduler/CLAUDE.md "Adding a check". Filled in by its own PR.
export const jobs: Job[] = [];
export const builtins: Record<string, Builtin> = {};
