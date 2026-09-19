import { existsSync } from 'node:fs';
import { registerSecret } from './secrets.js';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface Config {
  algotest: { phone: string; password: string };
  angelone: { clientCode: string; mpin: string; totpSecret: string };
  shoonya: { clientId: string; password: string; totpSecret: string };
  telegram: TelegramConfig | null;
  headed: boolean;
  slowMo: number;
  skipWindowGuard: boolean;
  only: string | null;
  runUrl: string | null;
}

const ALWAYS_REQUIRED = ['ALGOTEST_PHONE', 'ALGOTEST_PASSWORD'] as const;

const BROKER_SECRET_KEYS = {
  angelone: ['ANGELONE_CLIENT_CODE', 'ANGELONE_MPIN', 'ANGELONE_TOTP_SECRET'],
  shoonya: ['SHOONYA_CLIENT_ID', 'SHOONYA_PASSWORD', 'SHOONYA_TOTP_SECRET'],
} as const;

type SecretKey =
  | (typeof ALWAYS_REQUIRED)[number]
  | (typeof BROKER_SECRET_KEYS)['angelone'][number]
  | (typeof BROKER_SECRET_KEYS)['shoonya'][number];

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

export function loadConfig(): Config {
  if (existsSync('.env')) process.loadEnvFile('.env');

  const only = process.env.ONLY?.trim() || null;
  if (only && !(only in BROKER_SECRET_KEYS)) {
    throw new Error(`ONLY=${only} matched no broker (expected: angelone, shoonya)`);
  }

  // A broker's secrets are only required while it's actually going to run, so an
  // ONLY=angelone run works even with Shoonya's TOTP secret still blank - the point
  // of ONLY existing at all is to bring brokers online one at a time.
  const activeBrokers = only
    ? [only as keyof typeof BROKER_SECRET_KEYS]
    : (Object.keys(BROKER_SECRET_KEYS) as (keyof typeof BROKER_SECRET_KEYS)[]);

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

  // A skipped broker never reaches broker.login() - main.ts filters by `only`
  // before that - so an empty placeholder here is inert, not a silent credential gap.
  const readOrBlank = (broker: keyof typeof BROKER_SECRET_KEYS, key: SecretKey): string =>
    activeBrokers.includes(broker) ? read(key) : '';

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
    shoonya: {
      clientId: readOrBlank('shoonya', 'SHOONYA_CLIENT_ID'),
      password: readOrBlank('shoonya', 'SHOONYA_PASSWORD'),
      totpSecret: readOrBlank('shoonya', 'SHOONYA_TOTP_SECRET'),
    },
    telegram: readTelegramConfig(),
    headed: process.env.HEADED === '1',
    slowMo: Number(process.env.SLOW_MO ?? 0),
    skipWindowGuard: process.env.SKIP_WINDOW_GUARD === '1',
    only,
    runUrl: runUrl(),
  };
}
