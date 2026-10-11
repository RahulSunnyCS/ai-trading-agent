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
  pid: number | null;
  log_path: string;
  error: string | null;
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
    this.db.exec('CREATE INDEX IF NOT EXISTS runs_job_started ON runs (job, started_at)');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
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

  /**
   * Close rows whose process no longer exists (the scheduler was killed or crashed mid-run),
   * so they stop blocking their group and stop showing as running. Returns how many.
   */
  reapDead(at: Date, alive: (pid: number) => boolean = pidAlive): number {
    const rows = this.db.query('SELECT id, pid FROM runs WHERE ended_at IS NULL').all() as Array<{
      id: number;
      pid: number | null;
    }>;
    let reaped = 0;
    for (const row of rows) {
      if (row.pid !== null && alive(row.pid)) continue;
      this.finish(row.id, -2, 0, at, 'interrupted: the scheduler stopped while this was running');
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

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
