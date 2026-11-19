import { Database } from 'bun:sqlite';

/**
 * Run history in a local SQLite file — not the DuckDB catalog, so recording a
 * run never competes with a job for the catalog's single writer.
 */
export type Trigger = 'schedule' | 'catch-up' | 'manual';

export interface RunRow {
  id: number;
  job: string;
  trigger: Trigger;
  /** ISO instant of the schedule slot this run serves; null for a manual run. */
  scheduled_for: string | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  attempts: number;
  /** the scheduler (or `jobs run`) process that wrote the row */
  pid: number | null;
  /**
   * The process group of the step running now (the runner spawns each step detached, in its own
   * group, so it outlives a scheduler that stops): null before the first step or for a builtin.
   */
  child_pgid: number | null;
  log_path: string;
  error: string | null;
}

/**
 * Where a chain's step stands (BL-234): `ok` ran and passed, `failed`, `skipped` (a step it
 * requires did not pass, or an earlier failure ended the chain), `held` (the stop button or the
 * settings pause), `late` (its `notAfter` time had passed when the chain got to it), `carried` (passed in the earlier run this one resumed), `running`, and
 * `unknown` (it was running when the scheduler stopped: it may have done its work).
 */
export type StepStatus =
  | 'ok'
  | 'failed'
  | 'skipped'
  | 'held'
  | 'late'
  | 'carried'
  | 'running'
  | 'unknown';

export interface StepRow {
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

export class History {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    // Wait for another process's write instead of failing at once: bun:sqlite's default is 0.
    this.db.exec('PRAGMA busy_timeout = 10000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL,
      trigger TEXT NOT NULL,
      scheduled_for TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      pid INTEGER,
      log_path TEXT NOT NULL,
      error TEXT
    )`);
    // BL-143: added later; older files get the column once.
    const columns = this.db.query('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'child_pgid')) {
      try {
        this.db.exec('ALTER TABLE runs ADD COLUMN child_pgid INTEGER');
      } catch (error) {
        // two processes opened an old file at once: the other one added it first
        if (!/duplicate column/i.test(String(error))) throw error;
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS runs_job_started ON runs (job, started_at)');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // BL-234: one row per step of a chain's run.
    this.db.exec(`CREATE TABLE IF NOT EXISTS run_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      step TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      carried_from INTEGER
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS run_steps_run ON run_steps (run_id)');
    // BL-234: the groups a chain's run holds right now (a chain takes a group at its first step that
    // needs it and lets go after its last), so another job waits only while one is really held.
    this.db.exec(`CREATE TABLE IF NOT EXISTS run_groups (
      run_id INTEGER NOT NULL,
      grp TEXT NOT NULL,
      PRIMARY KEY (run_id, grp)
    )`);
  }

  /** A step of a chain's run begins (status `running`); returns its row id. */
  startStep(runId: number, step: string, at: Date): number {
    const row = this.db
      .query(
        `INSERT INTO run_steps (run_id, step, status, started_at) VALUES (?, ?, 'running', ?) RETURNING id`,
      )
      .get(runId, step, at.toISOString()) as { id: number };
    return row.id;
  }

  /** A step ended, was skipped, held, or carried from an earlier run. */
  finishStep(
    id: number,
    status: StepStatus,
    exitCode: number | null,
    attempts: number,
    at: Date,
    error: string | null = null,
  ): void {
    this.db
      .query(
        'UPDATE run_steps SET status = ?, ended_at = ?, exit_code = ?, attempts = ?, error = ? WHERE id = ?',
      )
      .run(status, at.toISOString(), exitCode, attempts, error, id);
  }

  /** A step that did not run this time: skipped, held, or done in an earlier run (`carriedFrom`). */
  recordStep(
    runId: number,
    step: string,
    status: StepStatus,
    at: Date,
    error: string | null = null,
    carriedFrom: number | null = null,
  ): void {
    this.db
      .query(
        `INSERT INTO run_steps (run_id, step, status, started_at, ended_at, exit_code, attempts, error, carried_from)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        runId,
        step,
        status,
        at.toISOString(),
        at.toISOString(),
        status === 'ok' || status === 'carried' || status === 'held' || status === 'late'
          ? 0
          : null,
        error,
        carriedFrom,
      );
  }

  /** The steps of a run, in the order they started. */
  steps(runId: number): StepRow[] {
    return this.db
      .query('SELECT * FROM run_steps WHERE run_id = ? ORDER BY id')
      .all(runId) as StepRow[];
  }

  /**
   * What each step of `job` last came to in the runs a resume builds on: those that served the same
   * slot, or (a hand run, no slot) those that began at or after `since`, all before `beforeId`.
   * The LATEST row of a step wins, so a run that recorded no steps (a refused resume) or only some
   * (an Apply now) never hides a step that passed in an earlier run, and a step that failed again
   * later is not counted as passed.
   */
  priorSteps(
    job: string,
    beforeId: number,
    from: { slot: Date } | { since: Date },
  ): Map<string, StepRow> {
    const where =
      'slot' in from ? 'r.scheduled_for = ?' : 'r.started_at >= ? AND r.exit_code IS NOT -1';
    const value = 'slot' in from ? from.slot.toISOString() : from.since.toISOString();
    const rows = this.db
      .query(
        `SELECT s.* FROM run_steps s JOIN runs r ON r.id = s.run_id
         WHERE r.job = ? AND r.id < ? AND ${where} ORDER BY s.run_id, s.id`,
      )
      .all(job, beforeId, value) as StepRow[];
    const latest = new Map<string, StepRow>();
    for (const row of rows) latest.set(row.step, row);
    return latest;
  }

  /** A chain's run takes a group (BL-234). */
  holdRunGroup(runId: number, group: string): void {
    this.db.query('INSERT OR IGNORE INTO run_groups (run_id, grp) VALUES (?, ?)').run(runId, group);
  }

  /** A chain's run lets a group go: another job may take it while the chain goes on. */
  releaseRunGroup(runId: number, group: string): void {
    this.db.query('DELETE FROM run_groups WHERE run_id = ? AND grp = ?').run(runId, group);
  }

  /**
   * Unfinished runs that hold `group` now: a job that has it as its own `group` (held for the whole
   * run), or a chain run that has taken it and not yet let it go. `olderThan` keeps two jobs that
   * start together from waiting on each other; a chain step asks without it, since a newer run may
   * hold the group when the chain gets to its step. `exceptRun` is the asking run itself.
   */
  groupHolders(
    group: string,
    ownGroupJobs: string[],
    exceptRun: number,
    olderThan: number = Number.MAX_SAFE_INTEGER,
  ): RunRow[] {
    const marks = ownGroupJobs.map(() => '?').join(', ');
    const own = ownGroupJobs.length > 0 ? `job IN (${marks}) OR ` : '';
    return this.db
      .query(
        `SELECT * FROM runs WHERE ended_at IS NULL AND id < ? AND id != ?
           AND (${own}id IN (SELECT run_id FROM run_groups WHERE grp = ?))`,
      )
      .all(olderThan, exceptRun, ...ownGroupJobs, group) as RunRow[];
  }

  /**
   * When the scheduler first ran on this machine. Slots before it are not
   * "missed" — they belonged to whatever scheduled the job before.
   */
  firstStart(now: Date): Date {
    this.db
      .query('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run('first_start', now.toISOString());
    const row = this.db.query('SELECT value FROM meta WHERE key = ?').get('first_start') as {
      value: string;
    };
    return new Date(row.value);
  }

  /**
   * When the scheduler first saw this job, recorded once. Slots before it are neither run
   * nor reported missed: a job just added to the registry did not exist at its earlier
   * slots. A new job is seen as of `now` minus its catch-up window, so a slot that has only
   * just passed still catches up when the scheduler restarts. A job that already has
   * scheduled rows (runs, catch-ups or missed slots) predates this record, so it counts from
   * the scheduler's first start and a slot it slept through is still reported. A manual run
   * does not count: trying a new job once by hand says nothing about the slots before it
   * existed.
   */
  jobFirstSeen(job: string, now: Date, catchUpHours = 0): Date {
    const key = `job_first_seen:${job}`;
    const hasHistory =
      this.db.query("SELECT 1 FROM runs WHERE job = ? AND trigger != 'manual' LIMIT 1").get(job) !==
      null;
    const seen = hasHistory
      ? this.firstStart(now)
      : new Date(now.getTime() - catchUpHours * 3_600_000);
    this.db
      .query('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run(key, seen.toISOString());
    const row = this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as {
      value: string;
    };
    return new Date(row.value);
  }

  /** Record a slot that was too late to catch up, so it is reported once. */
  recordMissed(job: string, scheduledFor: Date, at: Date, reason: string): void {
    this.db
      .query(
        `INSERT INTO runs (job, trigger, scheduled_for, started_at, ended_at, exit_code, attempts, log_path, error)
         VALUES (?, 'schedule', ?, ?, ?, -1, 0, '', ?)`,
      )
      .run(job, scheduledFor.toISOString(), at.toISOString(), at.toISOString(), reason);
  }

  /** Finished runs since `since` that failed or were missed. */
  failuresSince(since: Date): RunRow[] {
    return this.db
      .query(
        'SELECT * FROM runs WHERE started_at >= ? AND ended_at IS NOT NULL AND exit_code != 0 ORDER BY id',
      )
      .all(since.toISOString()) as RunRow[];
  }

  /**
   * Runs started in [since, until) that served a slot as a catch-up (the slot was missed while
   * the laptop slept or was off, BL-143): the morning summary lists the previous day's. A restart
   * of a run the scheduler's stop cut off (`restartIfInterruptedUntil`) is not one: its slot
   * already has an earlier row, the interrupted run, which the summary lists as a failure.
   */
  catchUpsBetween(since: Date, until: Date): RunRow[] {
    return this.db
      .query(
        `SELECT * FROM runs r WHERE r.trigger = 'catch-up' AND r.started_at >= ? AND r.started_at < ?
           AND NOT EXISTS (SELECT 1 FROM runs p WHERE p.job = r.job AND p.scheduled_for = r.scheduled_for AND p.id < r.id)
         ORDER BY r.started_at`,
      )
      .all(since.toISOString(), until.toISOString()) as RunRow[];
  }

  /** The run before `id` for the same job, to notice a recovery. */
  previous(job: string, id: number): RunRow | null {
    return (this.db
      .query('SELECT * FROM runs WHERE job = ? AND id < ? ORDER BY id DESC LIMIT 1')
      .get(job, id) ?? null) as RunRow | null;
  }

  start(
    job: string,
    trigger: Trigger,
    scheduledFor: Date | null,
    logPath: string,
    at: Date,
  ): number {
    const row = this.db
      .query(
        `INSERT INTO runs (job, trigger, scheduled_for, started_at, pid, log_path)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        job,
        trigger,
        scheduledFor?.toISOString() ?? null,
        at.toISOString(),
        process.pid,
        logPath,
      ) as {
      id: number;
    };
    return row.id;
  }

  finish(id: number, exitCode: number, attempts: number, at: Date, error: string | null = null) {
    this.db.query('DELETE FROM run_groups WHERE run_id = ?').run(id);
    this.db
      .query('UPDATE runs SET ended_at = ?, exit_code = ?, attempts = ?, error = ? WHERE id = ?')
      .run(at.toISOString(), exitCode, attempts, error, id);
  }

  last(job: string): RunRow | null {
    return (this.db
      .query('SELECT * FROM runs WHERE job = ? ORDER BY started_at DESC, id DESC LIMIT 1')
      .get(job) ?? null) as RunRow | null;
  }

  /** Any run recorded for this schedule slot, whatever its outcome. */
  forSlot(job: string, scheduledFor: Date): RunRow | null {
    return (this.db
      .query('SELECT * FROM runs WHERE job = ? AND scheduled_for = ? ORDER BY id DESC LIMIT 1')
      .get(job, scheduledFor.toISOString()) ?? null) as RunRow | null;
  }

  /**
   * Unfinished runs of these jobs with a lower id than `beforeId`. Waiting only for older
   * rows means two processes that start together order themselves by id instead of both
   * seeing nothing, or both waiting for each other.
   */
  runningBefore(jobs: string[], beforeId: number): RunRow[] {
    if (jobs.length === 0) return [];
    const marks = jobs.map(() => '?').join(', ');
    return this.db
      .query(`SELECT * FROM runs WHERE ended_at IS NULL AND id < ? AND job IN (${marks})`)
      .all(beforeId, ...jobs) as RunRow[];
  }

  /** The process group of the step a run is on now (each step is spawned in its own). */
  setChild(id: number, pgid: number | null): void {
    this.db.query('UPDATE runs SET child_pgid = ? WHERE id = ?').run(pgid, id);
  }

  /**
   * Close rows whose work no longer exists, so they stop blocking their group and stop showing as
   * running: the process that wrote the row is gone (the scheduler was killed, crashed or
   * restarted; a `jobs run` was Ctrl-C'd) AND so is the process group of its step, which is
   * detached and can outlive the writer as an orphan (a deploy still deploying). Returns how many.
   */
  reapDead(
    at: Date,
    alive: (pid: number) => boolean = pidAlive,
    groupAlive: (pgid: number) => boolean = pgidAlive,
  ): number {
    const rows = this.db
      .query('SELECT id, pid, child_pgid FROM runs WHERE ended_at IS NULL')
      .all() as Array<Pick<RunRow, 'id' | 'pid' | 'child_pgid'>>;
    let reaped = 0;
    for (const row of rows) {
      if (rowAlive(row, alive, groupAlive)) continue;
      this.finish(row.id, -2, 0, at, 'interrupted: the scheduler stopped while this was running');
      // BL-234: a step that was running may or may not have done its work: a resume never repeats
      // it unasked
      this.db
        .query(
          `UPDATE run_steps SET status = 'unknown', ended_at = ?, error = ?
           WHERE run_id = ? AND status = 'running'`,
        )
        .run(at.toISOString(), 'cut off while running: it may have done its work', row.id);
      reaped++;
    }
    return reaped;
  }

  get(id: number): RunRow | null {
    return (this.db.query('SELECT * FROM runs WHERE id = ?').get(id) ?? null) as RunRow | null;
  }

  recent(limit = 50, job?: string): RunRow[] {
    return (
      job
        ? this.db.query('SELECT * FROM runs WHERE job = ? ORDER BY id DESC LIMIT ?').all(job, limit)
        : this.db.query('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit)
    ) as RunRow[];
  }

  close(): void {
    this.db.close();
  }
}

/** Is an open run's work still there: its writer, or its step's process group? */
export function rowAlive(
  row: Pick<RunRow, 'pid' | 'child_pgid'>,
  alive: (pid: number) => boolean = pidAlive,
  groupAlive: (pgid: number) => boolean = pgidAlive,
): boolean {
  if (row.pid !== null && alive(row.pid)) return true;
  return row.child_pgid !== null && row.child_pgid !== undefined && groupAlive(row.child_pgid);
}

/** Does any process of this group still exist (`kill(-pgid, 0)`: ESRCH = none)? */
export function pgidAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
