import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The automation settings (BL-140) as the jobs read them: the current version the scheduler
 * writes to `automation-settings.json` beside its database whenever the owner saves the
 * dashboard's Settings › Automation page (apps/scheduler/src/automation.ts is the writer and
 * holds the validation). Read-only here.
 *
 * No file (the scheduler never started with BL-140) means today's setup, the scheduler's
 * DEFAULT_SETTINGS, so the jobs behave exactly as before until the owner saves something.
 * A file that cannot be read or parsed is an error: a job must not guess what the owner set.
 */

export type Platform = 'algotest' | 'quantiply';
export type Broker = 'finvasia' | 'angelone';
export type Book = 'core' | 't1';

export interface Row {
  login: boolean;
  list: 'none' | Book;
  upload: boolean;
  /** the platform multiplier (BL-140 Phase 4): an integer 1-10, 1 unless the owner sets it */
  multiplier: number;
  /** include the Buy add-on picks (default yes) */
  addon: boolean;
  /** BL-183: the picked Dir at 2 lots (its MTM SL doubled) on a non-expiry day (default no) */
  dirBoost: boolean;
  /** Quantiply only (BL-172): the clientwise MTM SL in rupees the 08:00 job keeps; null = leave it */
  mtmSl: number | null;
}

/**
 * A snapshot written before BL-172 has no MTM SL: the list's portfolio stop on a Quantiply row
 * (T1 ₹9,000, Core ₹8,000, the owner's choice of 2026-10-28), none on AlgoTest. The scheduler's
 * `defaultMtmSl` is the same rule.
 */
export function defaultMtmSl(platform: Platform, list: Row['list']): number | null {
  if (platform !== 'quantiply') return null;
  return list === 't1' ? 9000 : list === 'core' ? 8000 : null;
}

export interface Automation {
  version: number;
  masters: { logins: boolean; uploads: boolean; deploy: boolean };
  rows: Record<`${Platform}.${Broker}`, Row>;
  /** no uploads or deploys for any session up to and including this IST day; null = none */
  pause: { until: string | null };
  /** 'file' when read from the scheduler's snapshot, 'default' when there is none yet */
  source: 'file' | 'default';
}

export const DEFAULT_AUTOMATION: Automation = {
  version: 0,
  masters: { logins: true, uploads: true, deploy: false },
  rows: {
    'algotest.finvasia': {
      login: true,
      list: 't1',
      upload: true,
      multiplier: 1,
      addon: true,
      dirBoost: false,
      mtmSl: null,
    },
    'algotest.angelone': {
      login: false,
      list: 'none',
      upload: false,
      multiplier: 1,
      addon: true,
      dirBoost: false,
      mtmSl: null,
    },
    'quantiply.angelone': {
      login: true,
      list: 'core',
      upload: true,
      multiplier: 1,
      addon: true,
      dirBoost: false,
      mtmSl: 8000,
    },
    'quantiply.finvasia': {
      login: false,
      list: 'none',
      upload: false,
      multiplier: 1,
      addon: true,
      dirBoost: false,
      mtmSl: null,
    },
  },
  pause: { until: null },
  source: 'default',
};

const BROKERS: Broker[] = ['finvasia', 'angelone'];

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir =
    env.SCHEDULER_STATE_DIR?.trim() ||
    join(homedir(), 'Library', 'Application Support', 'ai-trading-agent');
  return join(dir, 'automation-settings.json');
}

export function readAutomation(path: string = settingsPath()): Automation {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_AUTOMATION;
    throw error;
  }
  const raw = JSON.parse(text) as Partial<Automation>;
  if (!raw.masters || !raw.rows) throw new Error(`${path}: not automation settings`);
  const rows = {} as Automation['rows'];
  for (const p of ['algotest', 'quantiply'] as const) {
    for (const b of BROKERS) {
      const row = raw.rows[`${p}.${b}`] as Partial<Row> | undefined;
      if (!row) throw new Error(`${path}: row ${p}.${b} missing`);
      if (!['none', 'core', 't1'].includes(row.list as string)) {
        throw new Error(`${path}: row ${p}.${b} has list ${JSON.stringify(row.list)}`);
      }
      // A snapshot written before Phase 4 has neither field: 1 and yes, what the jobs did. A bad
      // value is an error, never a guess: a wrong multiplier changes the size of a real order.
      const multiplier = row.multiplier ?? 1;
      if (!(Number.isInteger(multiplier) && multiplier >= 1 && multiplier <= 10)) {
        throw new Error(`${path}: row ${p}.${b} has multiplier ${JSON.stringify(row.multiplier)}`);
      }
      const addon = row.addon ?? true;
      if (typeof addon !== 'boolean') {
        throw new Error(`${path}: row ${p}.${b} has addon ${JSON.stringify(row.addon)}`);
      }
      const dirBoost = row.dirBoost ?? false; // a snapshot before BL-183: off
      if (typeof dirBoost !== 'boolean') {
        throw new Error(`${path}: row ${p}.${b} has dirBoost ${JSON.stringify(row.dirBoost)}`);
      }
      // BL-172: missing = the list's stop; anything else must be null or whole rupees 500-100,000.
      const mtmSl = row.mtmSl === undefined ? defaultMtmSl(p, row.list as Row['list']) : row.mtmSl;
      if (
        mtmSl !== null &&
        !(Number.isInteger(mtmSl) && mtmSl >= 500 && mtmSl <= 100_000 && p === 'quantiply')
      ) {
        throw new Error(`${path}: row ${p}.${b} has mtmSl ${JSON.stringify(row.mtmSl)}`);
      }
      rows[`${p}.${b}`] = { ...(row as Row), multiplier, addon, dirBoost, mtmSl };
    }
  }
  const until = (raw.pause as { until?: unknown } | undefined)?.until ?? null;
  if (until !== null && !(typeof until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(until))) {
    throw new Error(`${path}: pause.until is ${JSON.stringify(until)}`);
  }
  return {
    version: Number(raw.version ?? 0),
    masters: raw.masters,
    rows,
    pause: { until },
    source: 'file',
  };
}

/** The pause's last day when a session on `session` (IST day) is paused, else null. Inclusive. */
export function pausedFor(a: Automation, session: string): string | null {
  const until = a.pause.until;
  return until !== null && session <= until ? until : null;
}

/** A row as the jobs must treat it: its choices gated by the master switches. */
export function effectiveRow(a: Automation, platform: Platform, broker: Broker): Row {
  const row = a.rows[`${platform}.${broker}`];
  return {
    login: a.masters.logins && row.login,
    list: row.list,
    upload: a.masters.uploads && row.upload && row.list !== 'none',
    multiplier: row.multiplier,
    addon: row.addon,
    dirBoost: row.dirBoost,
    mtmSl: row.mtmSl,
  };
}

/**
 * The lists to upload to a platform: for Quantiply one account per broker, so pass `broker`;
 * AlgoTest is one account whose brokers only matter at deploy, so it gets every list any of its
 * rows uploads.
 */
export function uploadBooks(a: Automation, platform: Platform, broker?: Broker): Book[] {
  const brokers = broker ? [broker] : BROKERS;
  const books = new Set<Book>();
  for (const b of brokers) {
    const row = effectiveRow(a, platform, b);
    if (row.upload && row.list !== 'none') books.add(row.list);
  }
  return [...books].sort();
}

/**
 * Whether the tool may ENABLE (deploy) a Quantiply account's algos, and which list they come
 * from: the deploy master switch, and the account's row uploading a list (an account the tool
 * puts nothing into has nothing of the tool's to enable). `why` says what held it back.
 */
export function quantiplyDeploy(
  a: Automation,
  broker: Broker,
): { ok: boolean; book: Book | null; why: string } {
  const row = effectiveRow(a, 'quantiply', broker);
  const book = row.list === 'none' ? null : row.list;
  if (!a.masters.deploy) return { ok: false, book, why: 'Automated deployment is off' };
  if (!row.upload) return { ok: false, book, why: `the Quantiply · ${broker} row uploads nothing` };
  return { ok: true, book, why: '' };
}

/** One line for logs and Telegram: which version decided, or that none was saved yet. */
export function describeSource(a: Automation): string {
  return a.source === 'file' ? `settings v${a.version}` : 'settings: defaults (none saved yet)';
}

/**
 * Why the AlgoTest deployer must not run: it checks the deploy sheet's multiplier but never sets
 * it (AlgoTest's is 1 until changed in the sheet by hand), so a row that uploads at more than 1 is
 * deployed by the owner. Null when every uploading AlgoTest row is at 1.
 */
export function algotestMultiplierRefusal(a: Automation): string | null {
  const wrong = BROKERS.map((b) => ({ b, row: effectiveRow(a, 'algotest', b) })).filter(
    ({ row }) => row.upload && row.multiplier !== 1,
  );
  if (!wrong.length) return null;
  return `AlgoTest multiplier ${wrong.map(({ b, row }) => `${b} ${row.multiplier}`).join(', ')}: the deployer never sets the multiplier, so it deploys nothing; deploy by hand`;
}
