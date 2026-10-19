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
}

export interface Automation {
  version: number;
  masters: { logins: boolean; uploads: boolean; deploy: boolean };
  rows: Record<`${Platform}.${Broker}`, Row>;
  /** 'file' when read from the scheduler's snapshot, 'default' when there is none yet */
  source: 'file' | 'default';
}

export const DEFAULT_AUTOMATION: Automation = {
  version: 0,
  masters: { logins: true, uploads: true, deploy: false },
  rows: {
    'algotest.finvasia': { login: true, list: 't1', upload: true },
    'algotest.angelone': { login: true, list: 'none', upload: false },
    'quantiply.angelone': { login: true, list: 'core', upload: true },
    'quantiply.finvasia': { login: false, list: 'none', upload: false },
  },
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
  for (const p of ['algotest', 'quantiply'] as const) {
    for (const b of BROKERS) {
      const row = raw.rows[`${p}.${b}`];
      if (!row) throw new Error(`${path}: row ${p}.${b} missing`);
      if (!['none', 'core', 't1'].includes(row.list)) {
        throw new Error(`${path}: row ${p}.${b} has list ${JSON.stringify(row.list)}`);
      }
    }
  }
  return {
    version: Number(raw.version ?? 0),
    masters: raw.masters,
    rows: raw.rows,
    source: 'file',
  };
}

/** A row as the jobs must treat it: its choices gated by the master switches. */
export function effectiveRow(a: Automation, platform: Platform, broker: Broker): Row {
  const row = a.rows[`${platform}.${broker}`];
  return {
    login: a.masters.logins && row.login,
    list: row.list,
    upload: a.masters.uploads && row.upload && row.list !== 'none',
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

/** One line for logs and Telegram: which version decided, or that none was saved yet. */
export function describeSource(a: Automation): string {
  return a.source === 'file' ? `settings v${a.version}` : 'settings: defaults (none saved yet)';
}
