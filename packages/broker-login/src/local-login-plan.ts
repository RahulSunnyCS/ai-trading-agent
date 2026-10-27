import { type Automation, effectiveRow } from './automation-settings.js';
import type { BrokerResult } from './brokers/types.js';

/**
 * BL-172 Phases 1-2, the browser-free half of `local-login.ts`: the morning login runs on the Mac
 * from the automation settings and `.env`, and GitHub's "Daily broker login" is only the backup.
 */

/** What `main.ts` reads, derived from Settings › Automation (the scheduler's GitHub variables, same rule). */
export interface LoginEnv {
  /** '' both AlgoTest brokers, one broker key, or 'none' */
  ONLY: string;
  QUANTIPLY_LOGIN: 'on' | 'off';
  /** comma-separated Quantiply accounts; `finvasia` logs Quantiply · Shoonya in */
  QUANTIPLY_BROKERS: string;
}

const BROKERS = ['finvasia', 'angelone'] as const;

/** The logins the settings ask for, or null when there is none (or logins are off). */
export function loginEnv(a: Automation): LoginEnv | null {
  const on = (p: 'algotest' | 'quantiply') =>
    BROKERS.filter((b) => effectiveRow(a, p, b).login) as string[];
  const algotest = on('algotest');
  const quantiply = on('quantiply');
  if (!algotest.length && !quantiply.length) return null;
  return {
    ONLY: algotest.length === BROKERS.length ? '' : (algotest[0] ?? 'none'),
    QUANTIPLY_LOGIN: quantiply.includes('angelone') ? 'on' : 'off',
    QUANTIPLY_BROKERS: quantiply.join(','),
  };
}

/** `main.ts`'s outcome, written to `LOGIN_RESULT_FILE` at its end. */
export interface LoginResult {
  /** the AlgoTest broker lines, null when AlgoTest was not asked */
  algotest: BrokerResult[] | null;
  quantiply: BrokerResult | null;
  quantiplyShoonya: BrokerResult | null;
  fatal: string | null;
}

/**
 * A refusal of the credentials themselves (a wrong password, PIN or code): sending them again from
 * GitHub would only count toward a lockout, so such a failure is never handed to the backup.
 */
export const REFUSED =
  /wrong password|invalid (pin|mpin|password|input|credentials|totp|otp)|incorrect (pin|password|otp)|check credentials|locked|blocked/i;

function failedElsewhereFixable(r: BrokerResult | null): boolean {
  return r !== null && r.status === 'FAIL' && !REFUSED.test(r.detail);
}

/** The GitHub workflow's dispatch inputs for the parts to try again there. */
export interface Fallback {
  only: string;
  quantiply: 'on' | 'off';
  quantiplyShoonya: 'on' | 'off';
  parts: string[];
}

/**
 * What GitHub should try again: every asked part that failed for a reason another machine could
 * fix. No result at all (the run crashed or timed out before writing one) tries every asked part.
 * Null when nothing is left to try (all logged in, or every failure is a refusal).
 */
export function fallback(env: LoginEnv, r: LoginResult | null): Fallback | null {
  const askedAlgotest = env.ONLY !== 'none';
  const askedShoonya = env.QUANTIPLY_BROKERS.split(',').includes('finvasia');
  const askedAngel = env.QUANTIPLY_LOGIN === 'on';
  let algotest: string[] = [];
  let angel = false;
  let shoonya = false;
  if (r === null) {
    algotest = askedAlgotest ? (env.ONLY ? [env.ONLY] : [...BROKERS]) : [];
    angel = askedAngel;
    shoonya = askedShoonya;
  } else {
    if (askedAlgotest) {
      if (r.fatal && !REFUSED.test(r.fatal) && !(r.algotest ?? []).length) {
        algotest = env.ONLY ? [env.ONLY] : [...BROKERS];
      } else {
        for (const b of r.algotest ?? []) {
          if (!failedElsewhereFixable(b)) continue;
          const key = /angel/i.test(b.name) ? 'angelone' : 'finvasia';
          algotest.push(key);
        }
      }
    }
    angel = askedAngel && failedElsewhereFixable(r.quantiply);
    shoonya = askedShoonya && failedElsewhereFixable(r.quantiplyShoonya);
  }
  if (!algotest.length && !angel && !shoonya) return null;
  const parts = [
    ...algotest.map((b) => `AlgoTest · ${b === 'angelone' ? 'Angel One' : 'Finvasia'}`),
    ...(angel ? ['Quantiply · Angel One'] : []),
    ...(shoonya ? ['Quantiply · Shoonya'] : []),
  ];
  return {
    only: algotest.length === BROKERS.length ? '' : (algotest[0] ?? 'none'),
    quantiply: angel ? 'on' : 'off',
    quantiplyShoonya: shoonya ? 'on' : 'off',
    parts,
  };
}

/** Every asked part logged in (or already was). */
export function allLoggedIn(r: LoginResult): boolean {
  const lines = [...(r.algotest ?? []), r.quantiply, r.quantiplyShoonya].filter(
    (x): x is BrokerResult => x !== null,
  );
  return r.fatal === null && lines.every((x) => x.status !== 'FAIL');
}

/** The `.env` broker credentials GitHub's backup keeps its own copies of (repository secrets). */
export const BACKUP_SECRETS = [
  'ALGOTEST_PHONE',
  'ALGOTEST_PASSWORD',
  'ANGELONE_CLIENT_CODE',
  'ANGELONE_MPIN',
  'ANGELONE_TOTP_SECRET',
  'SHOONYA_CLIENT_ID',
  'SHOONYA_PASSWORD',
  'SHOONYA_TOTP_SECRET',
] as const;

/**
 * BL-172 Phase 3: the secrets whose `.env` value changed since the last run, from per-name
 * digests (never the values). The first run, with nothing stored, reports nothing.
 */
export function changedSecrets(
  before: Record<string, string> | null,
  now: Record<string, string>,
): string[] {
  if (!before) return [];
  return BACKUP_SECRETS.filter((k) => now[k] !== undefined && before[k] !== now[k]);
}

/** The Telegram text for changed secrets: what to copy to GitHub, without printing a value. */
export function secretsReminder(names: string[]): string {
  const lines = names.map(
    (n) => `grep '^${n}=' .env | cut -d= -f2- | tr -d '\\n' | gh secret set ${n}`,
  );
  return [
    `⚠️ .env changed: ${names.join(', ')}. GitHub's backup login still has the old value: update its secret, from the repo root:`,
    ...lines,
  ].join('\n');
}
