import { existsSync } from 'node:fs';
import { registerSecret } from './secrets.js';

export interface Config {
  algotest: { phone: string; password: string };
  angelone: { clientCode: string; mpin: string; totpSecret: string };
  shoonya: { clientId: string; password: string; totpSecret: string };
  telegram: { botToken: string; chatId: string } | null;
  headed: boolean;
  slowMo: number;
  skipWindowGuard: boolean;
  only: string | null;
  runUrl: string | null;
}

const REQUIRED = [
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
 * The login field sits next to a static "+91" prefix and wants the bare 10 digits,
 * so accept whatever format the secret is stored in and strip it down.
 */
function normalizePhone(raw: string): string {
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

export function loadConfig(): Config {
  if (existsSync('.env')) process.loadEnvFile('.env');

  const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env for local runs, or set repository secrets for Actions.',
    );
  }

  const read = (key: (typeof REQUIRED)[number]): string => {
    const value = process.env[key]!.trim();
    registerSecret(value);
    return value;
  };

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (botToken) registerSecret(botToken);

  return {
    algotest: { phone: normalizePhone(read('ALGOTEST_PHONE')), password: read('ALGOTEST_PASSWORD') },
    angelone: {
      clientCode: read('ANGELONE_CLIENT_CODE'),
      mpin: read('ANGELONE_MPIN'),
      totpSecret: read('ANGELONE_TOTP_SECRET'),
    },
    shoonya: {
      clientId: read('SHOONYA_CLIENT_ID'),
      password: read('SHOONYA_PASSWORD'),
      totpSecret: read('SHOONYA_TOTP_SECRET'),
    },
    telegram: botToken && chatId ? { botToken, chatId } : null,
    headed: process.env.HEADED === '1',
    slowMo: Number(process.env.SLOW_MO ?? 0),
    skipWindowGuard: process.env.SKIP_WINDOW_GUARD === '1',
    only: process.env.ONLY?.trim() || null,
    runUrl: runUrl(),
  };
}
