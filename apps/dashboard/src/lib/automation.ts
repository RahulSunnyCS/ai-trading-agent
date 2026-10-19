/**
 * Shapes, labels and small rules for the automation settings (BL-140), served by the
 * scheduler at `/api/scheduler/settings/automation` (apps/scheduler/src/automation.ts holds the
 * same shapes and the validation). Kept free of React so it can be unit-tested.
 */

export type List = 'none' | 'core' | 't1';
export type RowKey =
  | 'algotest.finvasia'
  | 'algotest.angelone'
  | 'quantiply.angelone'
  | 'quantiply.finvasia';

export interface Row {
  login: boolean;
  list: List;
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

export interface SettingsVersion {
  version: number;
  saved_at: string;
  settings: AutomationSettings;
  github: string | null;
}

export interface AutomationView {
  current: SettingsVersion;
  effective: Record<RowKey, Row>;
  github: Record<string, string>;
  history: SettingsVersion[];
}

/** The page's row order: AlgoTest first, each platform's usual broker first. */
export const ROWS: { key: RowKey; platform: string; broker: string }[] = [
  { key: 'algotest.finvasia', platform: 'AlgoTest', broker: 'Shoonya' },
  { key: 'algotest.angelone', platform: 'AlgoTest', broker: 'Angel One' },
  { key: 'quantiply.angelone', platform: 'Quantiply', broker: 'Angel One' },
  { key: 'quantiply.finvasia', platform: 'Quantiply', broker: 'Shoonya' },
];

export const LIST_LABEL: Record<List, string> = {
  none: 'None',
  core: 'Adaptive Classic',
  t1: 'Adaptive Tuned',
};

export const MASTER_LABEL: Record<keyof Masters, string> = {
  logins: 'Automated logins',
  uploads: 'Automated uploads',
  deploy: 'Automated deployment',
};

export function rowLabel(key: RowKey): string {
  const row = ROWS.find((r) => r.key === key);
  return row ? `${row.platform} · ${row.broker}` : key;
}

/** `settings` with one row changed; choosing no list also turns its upload off. */
export function withRow(
  settings: AutomationSettings,
  key: RowKey,
  change: Partial<Row>,
): AutomationSettings {
  const row = { ...settings.rows[key], ...change };
  if (row.list === 'none') row.upload = false;
  return { ...settings, rows: { ...settings.rows, [key]: row } };
}

export function withMaster(
  settings: AutomationSettings,
  key: keyof Masters,
  on: boolean,
): AutomationSettings {
  return { ...settings, masters: { ...settings.masters, [key]: on } };
}

const onOff = (v: boolean) => (v ? 'on' : 'off');

/** Plain-English lines for what differs between two versions, in page order. */
export function describeChanges(before: AutomationSettings, after: AutomationSettings): string[] {
  const lines: string[] = [];
  for (const key of ['logins', 'uploads', 'deploy'] as const) {
    if (before.masters[key] !== after.masters[key]) {
      lines.push(
        `${MASTER_LABEL[key]}: ${onOff(before.masters[key])} → ${onOff(after.masters[key])}`,
      );
    }
  }
  for (const { key } of ROWS) {
    const a = before.rows[key];
    const b = after.rows[key];
    if (a.login !== b.login)
      lines.push(`${rowLabel(key)} login: ${onOff(a.login)} → ${onOff(b.login)}`);
    if (a.list !== b.list)
      lines.push(`${rowLabel(key)} list: ${LIST_LABEL[a.list]} → ${LIST_LABEL[b.list]}`);
    if (a.upload !== b.upload)
      lines.push(`${rowLabel(key)} upload: ${onOff(a.upload)} → ${onOff(b.upload)}`);
  }
  return lines;
}

/** Why a row will not do what it says: its master switch is off. Null when nothing is held back. */
export function heldByMaster(settings: AutomationSettings, key: RowKey): string | null {
  const row = settings.rows[key];
  const held: string[] = [];
  if (row.login && !settings.masters.logins) held.push('login');
  if (row.upload && !settings.masters.uploads) held.push('upload');
  return held.length ? `${held.join(' and ')} held off by the master switch` : null;
}

/** The GitHub sync outcome in a few words, and whether it failed. */
export function githubOutcome(github: string | null): { text: string; failed: boolean } | null {
  if (!github) return null;
  if (github.startsWith('ok')) return { text: 'GitHub backstop updated', failed: false };
  if (github.startsWith('PARTIAL')) {
    return {
      text: `GitHub backstop partly updated: ${github.replace(/^PARTIAL:\s*/, '')}`,
      failed: true,
    };
  }
  return { text: `GitHub backstop NOT updated: ${github.replace(/^FAILED\s*/, '')}`, failed: true };
}

/**
 * Apply now runs a platform's evening upload, which replaces today's strategies with tomorrow's:
 * only once today's session is over (15:30 IST), when none of today's picks can still trade. The
 * uploaders refuse earlier anyway; the page says so instead of starting a run that fails.
 */
export function applyNowOpen(now: Date = new Date()): boolean {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes() >= 15 * 60 + 30;
}
