/**
 * Shapes and small rules for the scheduler's loopback API (apps/scheduler/src/api.ts),
 * reached at `/api/scheduler/*` — which only resolves when the dashboard runs with
 * SCHEDULER_DIRECT=1 (the dev stack sets it). Kept free of React so it can be unit-tested.
 */

import type { Status } from '../components/ui/Badge';

export const SCHEDULER_API = '/api/scheduler';

export type JobNeed = 'home' | 'gui' | 'postgres';

export interface SchedulerRun {
  id: number;
  job: string;
  trigger: 'schedule' | 'catch-up' | 'manual';
  scheduled_for: string | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  attempts: number;
  error: string | null;
}

export interface SchedulerJob {
  id: string;
  description: string;
  /** Human label, e.g. "Mon-Fri 17:00 IST". */
  schedule: string;
  nextRun: string | null;
  lastRun: SchedulerRun | null;
  needs: JobNeed[];
  group: string | null;
  /** BL-234: the step ids of a chain, in order; null (or absent from an older scheduler) for a plain job. */
  chain?: string[] | null;
}

/**
 * BL-234 Phase 3: the evening chain, and the steps each platform's "Apply now" runs of it (only
 * those, not the data steps): export tomorrow's picks, replace what the tool put there, and for
 * AlgoTest set up execution.
 */
export const EVENING_CHAIN = 'evening';
export const APPLY_NOW_STEPS = {
  AlgoTest: ['algotest-export', 'algotest-upload', 'algotest-setup'],
  Quantiply: ['quantiply-export', 'quantiply-upload'],
} as const;

/** Where one step of a chain's run stands (BL-234). */
export type StepStatus =
  | 'ok'
  | 'failed'
  | 'skipped'
  | 'held'
  | 'late'
  | 'carried'
  | 'running'
  | 'unknown';

export interface SchedulerStep {
  id: number;
  run_id: number;
  step: string;
  status: StepStatus;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  attempts: number;
  error: string | null;
  /** the earlier run whose pass this step carries */
  carried_from: number | null;
}

export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  ok: 'Passed',
  failed: 'Failed',
  skipped: 'Skipped',
  held: 'Held',
  late: 'Too late',
  carried: 'Done earlier',
  running: 'Running',
  unknown: 'May have run',
};

/** The Badge state for a step: a failure is red, a step that may have acted is a warning. */
export function stepBadge(status: StepStatus): Status {
  switch (status) {
    case 'ok':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    case 'skipped':
    case 'unknown':
      return 'attention';
    default:
      return 'queued';
  }
}

/** A chain's last run can be resumed when it ended and some step did not pass. */
export function canResume(
  job: Pick<SchedulerJob, 'chain' | 'lastRun'>,
  steps: readonly SchedulerStep[] | null,
): boolean {
  if (!job.chain || !job.lastRun || job.lastRun.ended_at === null) return false;
  return (steps ?? []).some(
    (s) => s.status === 'failed' || s.status === 'skipped' || s.status === 'unknown',
  );
}

export interface SchedulerLog {
  run: number;
  path: string;
  lines: number;
  text: string;
}

/** Where a run stands: still going, finished clean, or finished with a failure. */
export function runStatus(run: SchedulerRun | null): Status | null {
  if (!run) return null;
  if (run.ended_at === null) return 'running';
  return run.exit_code === 0 ? 'completed' : 'failed';
}

export const RUN_STATUS_LABEL: Partial<Record<Status, string>> = {
  running: 'Running',
  completed: 'Succeeded',
  failed: 'Failed',
};

/** Milliseconds a finished run took; null while running or when the stamps are unusable. */
export function runDurationMs(run: SchedulerRun | null): number | null {
  if (!run?.ended_at) return null;
  const ms = Date.parse(run.ended_at) - Date.parse(run.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * The first sentence of a job's description, for the Jobs table's row (the whole text is in the
 * job's panel). A sentence ends at ". ", "! " or "? " followed by a capital, a digit or a quote,
 * outside brackets, so "the repo .env. A part…" splits after ".env." and "e.g. the" does not.
 * A text with no such end is returned whole.
 */
export function firstSentence(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length - 2; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if ((ch === ')' || ch === ']') && depth > 0) depth -= 1;
    else if (
      depth === 0 &&
      (ch === '.' || ch === '!' || ch === '?') &&
      /\s/.test(text[i + 1] ?? '')
    ) {
      const next = text.slice(i + 1).trimStart()[0] ?? '';
      if (/[A-Z0-9"'`(]/.test(next)) return text.slice(0, i + 1);
    }
  }
  return text;
}

/** A job that needs the owner's laptop session (residential IP or a browser window). */
export function needsConfirmation(job: Pick<SchedulerJob, 'needs'>): boolean {
  return job.needs.includes('home') || job.needs.includes('gui');
}

/** A friendly sentence for a failed "Run now" (the API answers 409 busy, 404 unknown). */
export function runNowError(status: number | undefined, error: string): string {
  if (status === 409) return `Not started: ${error}. Try again when it finishes.`;
  if (status === 404) return 'The scheduler does not know that job (is it an older build?).';
  return `Could not start the run: ${error}`;
}

/** How much of a type goes to Telegram (BL-173): everything, only its failures, or nothing. */
export type NotificationLevel = 'all' | 'failures' | 'off';

export interface NotificationRow {
  type: string;
  description: string;
  enabled: boolean;
  /** absent from a scheduler that predates BL-173: read as `all` / `off` from `enabled` */
  level?: NotificationLevel;
}

/** A row's level, also from a scheduler that sends only `enabled`. */
export function levelOfRow(row: NotificationRow): NotificationLevel {
  return row.level ?? (row.enabled ? 'all' : 'off');
}

/** `rows` with one type at `level`. */
export function withLevel(
  rows: readonly NotificationRow[],
  type: string,
  level: NotificationLevel,
): NotificationRow[] {
  return rows.map((row) => (row.type === type ? { ...row, level, enabled: level !== 'off' } : row));
}

/** The PUT body (BL-173): every type's level. */
export function levelsBody(rows: readonly NotificationRow[]): {
  levels: Record<string, NotificationLevel>;
} {
  return { levels: Object.fromEntries(rows.map((row) => [row.type, levelOfRow(row)])) };
}

/** The PUT body for a set of rows: every type that is switched off. */
export function disabledTypes(rows: readonly NotificationRow[]): string[] {
  return rows.filter((row) => !row.enabled).map((row) => row.type);
}

/** Failure alerts (`momentum.problem`, `options.problem`): silencing one hides a real fault. */
export function isProblemType(type: string): boolean {
  return type.endsWith('.problem');
}

/** `rows` with one type switched on or off. */
export function withEnabled(
  rows: readonly NotificationRow[],
  type: string,
  enabled: boolean,
): NotificationRow[] {
  return rows.map((row) => (row.type === type ? { ...row, enabled } : row));
}
