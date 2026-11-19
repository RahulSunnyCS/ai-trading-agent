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

/**
 * BL-234 Phase 4: the morning login is two steps of the scheduler's `morning-open` chain, so
 * Quantiply can be switched on before AlgoTest's 08:16 window. `quantiply` is Quantiply · Angel
 * One (and Kite); `algotest` is the AlgoTest broker logins and, after them, Quantiply · Shoonya
 * (one process with AlgoTest's Finvasia login, which shares its TOTP seed); `all` is the whole
 * login in one run (a hand run, as before).
 */
export type LoginPart = 'quantiply' | 'algotest' | 'all';

export function parsePart(value: string | undefined): LoginPart {
  if (value === undefined) return 'all';
  if (value === 'quantiply' || value === 'algotest' || value === 'all') return value;
  throw new Error(`--part ${value}: expected quantiply, algotest or all`);
}

/** What `main.ts` gets for one part, or null when the settings ask nothing of that part. */
export function partEnv(env: LoginEnv, part: LoginPart): LoginEnv | null {
  if (part === 'all') return env;
  if (part === 'quantiply') {
    if (env.QUANTIPLY_LOGIN !== 'on') return null;
    return { ONLY: 'none', QUANTIPLY_LOGIN: 'on', QUANTIPLY_BROKERS: 'angelone' };
  }
  const shoonya = env.QUANTIPLY_BROKERS.split(',')
    .map((b) => b.trim())
    .includes('finvasia');
  if (env.ONLY === 'none' && !shoonya) return null;
  return { ONLY: env.ONLY, QUANTIPLY_LOGIN: 'off', QUANTIPLY_BROKERS: shoonya ? 'finvasia' : '' };
}

/** One part's outcome, as `local-login.ts` records it. */
export interface PartBody {
  ok: boolean;
  nothing?: boolean;
  github?: string;
  fallback?: { parts: string[]; url: string | null } | null;
  result?: LoginResult | null;
  note?: string | undefined;
}

/**
 * The status file's top level (what the 09:00 summary and the morning message read) from each
 * part's own body. A part run again by hand replaces its own body, so an old failure never
 * outlives the run that fixed it.
 */
export function combineParts(parts: Record<string, PartBody>): PartBody {
  const bodies = Object.values(parts);
  const results = bodies.map((b) => b.result).filter((r): r is LoginResult => !!r);
  const fallbacks = bodies
    .map((b) => b.fallback)
    .filter((f): f is NonNullable<PartBody['fallback']> => !!f);
  const github = bodies.find((b) => b.github)?.github;
  const note = bodies.find((b) => b.note)?.note;
  return {
    ok: bodies.every((b) => b.ok),
    ...(bodies.length > 0 && bodies.every((b) => b.nothing) ? { nothing: true } : {}),
    ...(github ? { github } : {}),
    ...(fallbacks.length
      ? {
          fallback: {
            parts: fallbacks.flatMap((f) => f.parts),
            url: fallbacks.find((f) => f.url)?.url ?? null,
          },
        }
      : {}),
    result: results.length
      ? {
          algotest: results.find((r) => r.algotest)?.algotest ?? null,
          quantiply: results.find((r) => r.quantiply)?.quantiply ?? null,
          quantiplyShoonya: results.find((r) => r.quantiplyShoonya)?.quantiplyShoonya ?? null,
          fatal: results.find((r) => r.fatal)?.fatal ?? null,
        }
      : null,
    ...(note ? { note } : {}),
  };
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

/**
 * Kite's unattended login (owner, 2026-10-28 on Fridays and Mondays; every day the job runs from
 * 2026-11-06, with the Angel One / AlgoTest logins): with `KITE_AUTO_LOGIN=on`. The job itself
 * runs on trading days only, so that is every trading day. `day` is the IST 'YYYY-MM-DD'.
 */
export function kiteDue(_day: string, env: Record<string, string | undefined>): boolean {
  return (env.KITE_AUTO_LOGIN ?? '').trim().toLowerCase() === 'on';
}

/** `mbt kite auto-login --json-out`'s outcome as a report line; null when unreadable. */
export function kiteResult(text: string | null): BrokerResult | null {
  if (!text) return null;
  try {
    const o = JSON.parse(text) as { status?: unknown; detail?: unknown };
    if (o.status !== 'OK' && o.status !== 'FAIL' && o.status !== 'SKIPPED') return null;
    return { name: 'Kite', status: o.status, detail: typeof o.detail === 'string' ? o.detail : '' };
  } catch {
    return null;
  }
}
