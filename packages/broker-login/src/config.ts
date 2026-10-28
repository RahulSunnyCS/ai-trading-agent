import { existsSync } from 'node:fs';
import { parseQuantiplyFlag } from './quantiply-rules.js';
import { registerSecret } from './secrets.js';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface Config {
  algotest: { phone: string; password: string };
  angelone: { clientCode: string; mpin: string; totpSecret: string };
  finvasia: { clientId: string; password: string; totpSecret: string };
  telegram: TelegramConfig | null;
  headed: boolean;
  slowMo: number;
  skipWindowGuard: boolean;
  only: string | null;
  /**
   * Quantiply (through Angel One) has a line in this run's report: QUANTIPLY_LOGIN is on, or is
   * set to something that isn't on/off. Independent of `only`.
   */
  quantiply: boolean;
  /**
   * Why Quantiply can't run (a bad QUANTIPLY_LOGIN value, or ANGELONE_* blank while AlgoTest's
   * Angel One login is off), else null. Reported as a Quantiply FAIL line; it never stops the
   * AlgoTest logins.
   */
  quantiplyProblem: string | null;
  /**
   * BL-140: also log in to Quantiply · Shoonya (quantiply.shoonya.com) with the SHOONYA_* secrets.
   * On when the repository variable QUANTIPLY_BROKERS (set by the dashboard's Settings ›
   * Automation) lists finvasia. Reported on its own line; never changes the run's exit code.
   */
  quantiplyShoonya: boolean;
  /** Why Quantiply · Shoonya can't run (its SHOONYA_* secrets are missing), else null. */
  quantiplyShoonyaProblem: string | null;
  runUrl: string | null;
}

const ALWAYS_REQUIRED = ['ALGOTEST_PHONE', 'ALGOTEST_PASSWORD'] as const;

// The object key is the internal broker identifier (`finvasia`, matching
// BrokerId in @trading/broker-identity and the `finvasia` broker/config
// keys everywhere else in this package). The env var names on the right
// stay SHOONYA_* — they are already-configured GitHub Actions repository
// secrets (an external contract), and renaming them would be a breaking
// change to that contract for a purely internal naming-consistency fix.
// Finvasia was formerly branded Shoonya; the broker itself now uses
// "Finvasia" everywhere (AlgoTest's UI, packages/contract-notes), which is
// why the internal identifier moved but the secret names didn't need to.
const BROKER_SECRET_KEYS = {
  angelone: ['ANGELONE_CLIENT_CODE', 'ANGELONE_MPIN', 'ANGELONE_TOTP_SECRET'],
  finvasia: ['SHOONYA_CLIENT_ID', 'SHOONYA_PASSWORD', 'SHOONYA_TOTP_SECRET'],
} as const;

type SecretKey =
  | (typeof ALWAYS_REQUIRED)[number]
  | (typeof BROKER_SECRET_KEYS)['angelone'][number]
  | (typeof BROKER_SECRET_KEYS)['finvasia'][number];

/**
 * The login field sits next to a static "+91" prefix and wants the bare 10 digits,
 * so accept whatever format the secret is stored in and strip it down.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const local = digits.replace(/^(?:0|91)(?=\d{10}$)/, '');
  if (local.length !== 10) {
    throw new Error(
      `ALGOTEST_PHONE should be a 10-digit Indian mobile number (got ${local.length} digits after cleanup)`,
    );
  }
  registerSecret(local);
  return local;
}

function runUrl(): string | null {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/**
 * Deliberately independent of loadConfig() and never throws: a failure loading the
 * REST of the config (a missing or misnamed secret, say) must still be able to reach
 * Telegram, so the alert path can't depend on the same validation that might be
 * what's broken.
 */
export function readTelegramConfig(): TelegramConfig | null {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (botToken) registerSecret(botToken);
  return botToken && chatId ? { botToken, chatId } : null;
}

/**
 * QUANTIPLY_LOGIN and the Angel One secrets -> whether Quantiply gets a report line, and why it
 * can't run if it can't. Never throws.
 */
export function quantiplyConfig(env: NodeJS.ProcessEnv): { line: boolean; problem: string | null } {
  let on: boolean;
  try {
    on = parseQuantiplyFlag(env.QUANTIPLY_LOGIN);
  } catch (error) {
    return { line: true, problem: `not run - ${error instanceof Error ? error.message : error}` };
  }
  if (!on) return { line: false, problem: null };
  const missing = BROKER_SECRET_KEYS.angelone.filter((key) => !env[key]?.trim());
  return missing.length > 0
    ? { line: true, problem: `not run - missing ${missing.join(', ')}` }
    : { line: true, problem: null };
}

export function loadConfig(): Config {
  if (existsSync('.env')) process.loadEnvFile('.env');

  // `both` (BL-172: the Mac's fallback dispatch asking for both AlgoTest brokers, since a blank
  // dispatch input means "the repository variable") is the same as blank.
  const rawOnly = process.env.ONLY?.trim();
  const only = rawOnly === 'both' ? null : rawOnly || null;
  // `none` (BL-140: no AlgoTest block logs in, set from the dashboard) skips the AlgoTest logins.
  if (only && only !== 'none' && !(only in BROKER_SECRET_KEYS)) {
    throw new Error(`ONLY=${only} matched no broker (expected: angelone, finvasia, none)`);
  }

  // A broker's secrets are only required while it's actually going to run, so an
  // ONLY=angelone run works even with Finvasia's TOTP secret still blank - the point
  // of ONLY existing at all is to bring brokers online one at a time.
  const activeBrokers =
    only === 'none'
      ? []
      : only
        ? [only as keyof typeof BROKER_SECRET_KEYS]
        : (Object.keys(BROKER_SECRET_KEYS) as (keyof typeof BROKER_SECRET_KEYS)[]);
  // BL-172: a dispatch's quantiply_shoonya input (on / off) wins over the repository variable.
  const shoonyaInput = process.env.QUANTIPLY_SHOONYA_INPUT?.trim().toLowerCase();
  const quantiplyShoonya =
    shoonyaInput === 'on'
      ? true
      : shoonyaInput === 'off'
        ? false
        : (process.env.QUANTIPLY_BROKERS ?? '')
            .split(',')
            .map((b) => b.trim().toLowerCase())
            .includes('finvasia');

  const required: readonly SecretKey[] = [
    ...ALWAYS_REQUIRED,
    ...activeBrokers.flatMap((broker) => BROKER_SECRET_KEYS[broker]),
  ];

  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env for local runs, or set repository secrets for Actions.',
    );
  }

  const read = (key: SecretKey): string => {
    const value = process.env[key]!.trim();
    registerSecret(value);
    return value;
  };

  // Quantiply logs in through Angel One with the same three secrets. Its own config problems
  // (a mistyped flag, blank secrets) only fail its line: the AlgoTest logins must still run.
  const quantiplySetting = quantiplyConfig(process.env);
  const quantiply = quantiplySetting.line;
  const quantiplyProblem = quantiplySetting.problem;
  const needsAngel = activeBrokers.includes('angelone') || (quantiply && !quantiplyProblem);

  // A skipped broker never reaches broker.login() - main.ts filters by `only`
  // before that - so an empty placeholder here is inert, not a silent credential gap.
  // Angel One's are read for Quantiply too.
  const shoonyaMissing = BROKER_SECRET_KEYS.finvasia.filter((key) => !process.env[key]?.trim());
  const quantiplyShoonyaProblem =
    quantiplyShoonya && shoonyaMissing.length
      ? `not run - missing ${shoonyaMissing.join(', ')}`
      : null;
  const needsShoonya =
    activeBrokers.includes('finvasia') || (quantiplyShoonya && !quantiplyShoonyaProblem);
  const readOrBlank = (broker: keyof typeof BROKER_SECRET_KEYS, key: SecretKey): string =>
    (broker === 'angelone' ? needsAngel : needsShoonya) ? read(key) : '';

  return {
    algotest: {
      phone: normalizePhone(read('ALGOTEST_PHONE')),
      password: read('ALGOTEST_PASSWORD'),
    },
    angelone: {
      clientCode: readOrBlank('angelone', 'ANGELONE_CLIENT_CODE'),
      mpin: readOrBlank('angelone', 'ANGELONE_MPIN'),
      totpSecret: readOrBlank('angelone', 'ANGELONE_TOTP_SECRET'),
    },
    finvasia: {
      clientId: readOrBlank('finvasia', 'SHOONYA_CLIENT_ID'),
      password: readOrBlank('finvasia', 'SHOONYA_PASSWORD'),
      totpSecret: readOrBlank('finvasia', 'SHOONYA_TOTP_SECRET'),
    },
    telegram: readTelegramConfig(),
    headed: process.env.HEADED === '1',
    slowMo: Number(process.env.SLOW_MO ?? 0),
    skipWindowGuard: process.env.SKIP_WINDOW_GUARD === '1',
    only,
    quantiply,
    quantiplyProblem,
    quantiplyShoonya,
    quantiplyShoonyaProblem,
    runUrl: runUrl(),
  };
}
