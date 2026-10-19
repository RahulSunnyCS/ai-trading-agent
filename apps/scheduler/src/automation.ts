import { Database } from 'bun:sqlite';
import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

/**
 * The automation settings (BL-140): what the daily jobs do, set from the dashboard's
 * Settings › Automation page instead of in code.
 *
 * - Three master switches: automated logins (the 08:00 run and its GitHub backstop),
 *   automated uploads (the evening and 09:16 top-up uploads) and automated deployment.
 *   With a master off, no row can turn that kind of automation on.
 * - One row per platform + broker (AlgoTest / Quantiply × Shoonya (Finvasia) / Angel One):
 *   log in at 08:00, which list it gets (none, Core = Adaptive Classic, T1 = Adaptive Tuned),
 *   upload it.
 *
 * Every Save is a new version in the scheduler's SQLite (`automation_settings`); nothing is
 * ever updated in place, so the page can show the history. The current version is also
 * written to `automation-settings.json` beside the database, which the jobs (TypeScript and
 * Python) read when they start. The `.env` switches (ALGOTEST_UPLOAD, QUANTIPLY_UPLOAD,
 * ALGOTEST_DEPLOY) stay as hard safety: a setting never overrides one that is off.
 */

export const PLATFORMS = ['algotest', 'quantiply'] as const;
export const BROKERS = ['finvasia', 'angelone'] as const;
export const LISTS = ['none', 'core', 't1'] as const;

export type Platform = (typeof PLATFORMS)[number];
export type Broker = (typeof BROKERS)[number];
export type List = (typeof LISTS)[number];
export type RowKey = `${Platform}.${Broker}`;

export interface Row {
  /** log this broker in on this platform at 08:00 */
  login: boolean;
  list: List;
  /** upload `list`'s picks to this platform (evening and 09:16 top-up) */
  upload: boolean;
}

export interface Masters {
  logins: boolean;
  uploads: boolean;
  deploy: boolean;
}

export interface AutomationSettings {
  masters: Masters;
  rows: Record<RowKey, Row>;
}

export interface Version {
  version: number;
  saved_at: string;
  settings: AutomationSettings;
  /** outcome of the GitHub variable sync for this version, or null if none was tried */
  github: string | null;
}

export const ROW_KEYS: RowKey[] = PLATFORMS.flatMap((p) =>
  BROKERS.map((b) => `${p}.${b}` as RowKey),
);

/** The owner's setup on 2026-10-19: the first version when nothing is saved yet. */
export const DEFAULT_SETTINGS: AutomationSettings = {
  masters: { logins: true, uploads: true, deploy: false },
  rows: {
    'algotest.finvasia': { login: true, list: 't1', upload: true },
    'algotest.angelone': { login: true, list: 'none', upload: false },
    'quantiply.angelone': { login: true, list: 'core', upload: true },
    'quantiply.finvasia': { login: false, list: 'none', upload: false },
  },
};

/** `value` as settings, or the reasons it is not. Unknown keys are refused, not dropped. */
export function validate(value: unknown): { settings: AutomationSettings } | { errors: string[] } {
  const errors: string[] = [];
  const obj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (!obj(value)) return { errors: ['settings must be an object'] };
  const extra = Object.keys(value).filter((k) => k !== 'masters' && k !== 'rows');
  if (extra.length) errors.push(`unknown keys: ${extra.join(', ')}`);

  const masters = value.masters;
  if (!obj(masters)) errors.push('masters must be an object');
  else {
    for (const k of Object.keys(masters))
      if (!['logins', 'uploads', 'deploy'].includes(k)) errors.push(`unknown master: ${k}`);
    for (const k of ['logins', 'uploads', 'deploy'])
      if (typeof masters[k] !== 'boolean') errors.push(`masters.${k} must be true or false`);
  }

  const rows = value.rows;
  if (!obj(rows)) errors.push('rows must be an object');
  else {
    for (const k of Object.keys(rows))
      if (!ROW_KEYS.includes(k as RowKey)) errors.push(`unknown row: ${k}`);
    for (const key of ROW_KEYS) {
      const row = rows[key];
      if (!obj(row)) {
        errors.push(`${key}: missing`);
        continue;
      }
      for (const k of Object.keys(row))
        if (!['login', 'list', 'upload'].includes(k)) errors.push(`${key}: unknown field ${k}`);
      if (typeof row.login !== 'boolean') errors.push(`${key}.login must be true or false`);
      if (typeof row.upload !== 'boolean') errors.push(`${key}.upload must be true or false`);
      if (!LISTS.includes(row.list as List))
        errors.push(`${key}.list must be one of ${LISTS.join(', ')}`);
      if (row.upload === true && row.list === 'none')
        errors.push(`${key}: upload is on but no list is chosen`);
    }
  }
  if (errors.length) return { errors };
  const v = value as unknown as AutomationSettings;
  // Rebuild in a fixed key order, so equal settings always serialise the same.
  return {
    settings: {
      masters: { logins: v.masters.logins, uploads: v.masters.uploads, deploy: v.masters.deploy },
      rows: Object.fromEntries(
        ROW_KEYS.map((k) => {
          const r = v.rows[k];
          return [k, { login: r.login, list: r.list, upload: r.upload }];
        }),
      ) as Record<RowKey, Row>,
    },
  };
}

/** What a job may actually do for a row: the row's choice, gated by its master switch. */
export function effective(settings: AutomationSettings, key: RowKey): Row {
  const row = settings.rows[key];
  return {
    login: settings.masters.logins && row.login,
    list: row.list,
    upload: settings.masters.uploads && row.upload && row.list !== 'none',
  };
}

/**
 * The repository variables the "Daily broker login" workflow reads, so its 08:15 cron
 * backstop follows the page as the laptop's 08:00 dispatch does.
 *
 * - `BROKER_LOGIN_ENABLED`: the logins master switch.
 * - `ALGOTEST_BROKERS` / `QUANTIPLY_BROKERS`: comma-separated brokers to log in on each.
 * - `BROKER_LOGIN_ONLY` / `QUANTIPLY_LOGIN`: what the workflow reads today. `ONLY` empty
 *   means both AlgoTest brokers, `none` means neither; Quantiply is on if any of its rows is.
 */
/**
 * Whether the workflow understands `BROKER_LOGIN_ONLY=none` (no AlgoTest login). It does from
 * BL-140 Phase 3 (PR #268); until then `none` would fail the 08:00 run, so the variable is left as
 * it is and the sync outcome says so.
 */
export const WORKFLOW_KNOWS_NONE = true;

export function githubVariables(settings: AutomationSettings): Record<string, string> {
  const on = (p: Platform) => BROKERS.filter((b) => effective(settings, `${p}.${b}`).login);
  const algotest = on('algotest');
  const quantiply = on('quantiply');
  const only =
    algotest.length === BROKERS.length ? '' : algotest.length === 1 ? (algotest[0] ?? '') : 'none';
  return {
    BROKER_LOGIN_ENABLED: settings.masters.logins ? 'on' : 'off',
    ALGOTEST_BROKERS: algotest.join(','),
    QUANTIPLY_BROKERS: quantiply.join(','),
    ...(only === 'none' && !WORKFLOW_KNOWS_NONE ? {} : { BROKER_LOGIN_ONLY: only }),
    QUANTIPLY_LOGIN: quantiply.length ? 'on' : 'off',
  };
}

export type GhRunner = (args: string[]) => Promise<void>;

const execFileP = promisify(execFile);
export const realGh: GhRunner = async (args) => {
  await execFileP('gh', args, { timeout: 60_000 });
};

/**
 * Set the workflow's repository variables. An empty value deletes the variable (GitHub does
 * not store empty ones; the workflow reads a missing one as empty). Returns a one-line outcome.
 */
export async function syncGithub(
  settings: AutomationSettings,
  gh: GhRunner = realGh,
): Promise<string> {
  const vars = githubVariables(settings);
  const failed: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    try {
      if (value === '') await gh(['variable', 'delete', name]).catch(() => undefined);
      else await gh(['variable', 'set', name, '--body', value]);
    } catch (error) {
      failed.push(
        `${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
    }
  }
  return failed.length
    ? `FAILED ${failed.length}/${Object.keys(vars).length}: ${failed.join('; ')}`
    : `ok: ${Object.entries(vars)
        .map(([k, v]) => `${k}=${v || '(unset)'}`)
        .join(' ')}`;
}

/** The versioned store, in the scheduler's SQLite file (its own connection; WAL). */
export class SettingsStore {
  private readonly db: Database;

  constructor(
    dbPath: string,
    /** where the current version is written for the jobs; null in tests that do not need it */
    private readonly snapshotPath: string | null,
  ) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 10000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS automation_settings (
      version INTEGER PRIMARY KEY AUTOINCREMENT,
      saved_at TEXT NOT NULL,
      settings TEXT NOT NULL,
      github TEXT
    )`);
  }

  private row(r: {
    version: number;
    saved_at: string;
    settings: string;
    github: string | null;
  }): Version {
    return { ...r, settings: JSON.parse(r.settings) as AutomationSettings };
  }

  /** The latest version; the defaults (version 0, never saved) when nothing is saved yet. */
  current(): Version {
    const r = this.db
      .query('SELECT * FROM automation_settings ORDER BY version DESC LIMIT 1')
      .get() as {
      version: number;
      saved_at: string;
      settings: string;
      github: string | null;
    } | null;
    return r ? this.row(r) : { version: 0, saved_at: '', settings: DEFAULT_SETTINGS, github: null };
  }

  history(limit = 20): Version[] {
    return (
      this.db
        .query('SELECT * FROM automation_settings ORDER BY version DESC LIMIT ?')
        .all(limit) as {
        version: number;
        saved_at: string;
        settings: string;
        github: string | null;
      }[]
    ).map((r) => this.row(r));
  }

  /** Store `settings` (already validated) as a new version and write the jobs' snapshot. */
  save(settings: AutomationSettings, now: Date = new Date()): Version {
    const r = this.db
      .query('INSERT INTO automation_settings (saved_at, settings) VALUES (?, ?) RETURNING *')
      .get(now.toISOString(), JSON.stringify(settings)) as {
      version: number;
      saved_at: string;
      settings: string;
      github: string | null;
    };
    const version = this.row(r);
    this.writeSnapshot(version);
    return version;
  }

  /** Record the GitHub sync outcome on a version (the only field ever written after a save). */
  noteGithub(version: number, outcome: string): void {
    this.db
      .query('UPDATE automation_settings SET github = ? WHERE version = ?')
      .run(outcome, version);
  }

  /** Write the current version for the jobs, atomically (temp file, then rename). */
  writeSnapshot(version: Version = this.current()): void {
    if (!this.snapshotPath) return;
    mkdirSync(dirname(this.snapshotPath), { recursive: true });
    const tmp = `${this.snapshotPath}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: version.version, saved_at: version.saved_at, ...version.settings }, null, 2)}\n`,
    );
    renameSync(tmp, this.snapshotPath);
  }

  close(): void {
    this.db.close();
  }
}
