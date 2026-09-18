import { existsSync } from 'node:fs';
import { generateTotp } from '../src/totp.js';
import { classifyError } from '../src/algotest.js';
import { redact, registerSecret } from '../src/secrets.js';

/**
 * Preflight, run locally before the first real login.
 *
 * The main thing it answers: are the stored TOTP secrets correct? A wrong secret
 * produces valid-looking 6-digit codes that the broker rejects, which is otherwise
 * indistinguishable from a selector bug at 08:35 in the morning.
 */

if (process.env.GITHUB_ACTIONS === 'true') {
  console.error('refusing to run in CI - this prints live TOTP codes');
  process.exit(1);
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}${ok ? '' : ` (got ${actual}, want ${expected})`}`);
}

console.log('RFC 6238 test vectors:');
const rfc = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
check('t=59', generateTotp(rfc, 59_000), '287082');
check('t=1111111109', generateTotp(rfc, 1_111_111_109_000), '081804');
check('t=2000000000', generateTotp(rfc, 2_000_000_000_000), '279037');

console.log('\nerror classification:');
check('invalid TOTP -> retryable', classifyError('Invalid TOTP'), 'TOTP_REJECTED');
check('invalid password -> no retry', classifyError('Invalid password'), 'CREDENTIALS_REJECTED');
check('locked -> no retry', classifyError('Account is locked'), 'CREDENTIALS_REJECTED');
check('window -> no retry', classifyError('allowed between 08:30'), 'LOGIN_WINDOW_CLOSED');

console.log('\nredaction:');
registerSecret('hunter2hunter2');
check(
  'secret scrubbed',
  redact('pw=hunter2hunter2'),
  'pw=***REDACTED***',
);

if (existsSync('.env')) {
  process.loadEnvFile('.env');
  console.log('\nlive TOTP codes - these must match your authenticator app right now:');
  const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);

  for (const [label, key] of [
    ['Angel One', 'ANGELONE_TOTP_SECRET'],
    ['Finvasia ', 'SHOONYA_TOTP_SECRET'],
  ] as const) {
    const secret = process.env[key]?.trim();
    if (!secret) {
      console.log(`  ${label}  (${key} not set)`);
      continue;
    }
    try {
      console.log(`  ${label}  ${generateTotp(secret)}   valid for ${secondsLeft}s`);
    } catch (error) {
      failures += 1;
      console.log(`  ${label}  FAIL ${error instanceof Error ? error.message : error}`);
    }
  }
  await checkTelegram();
} else {
  console.log('\nno .env found - skipping live TOTP check');
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Two-step because a chat id can't be known until the bot has received at least one
 * message: with only a token, looks up which chats have messaged the bot (so you can
 * find and copy the right TELEGRAM_CHAT_ID); with both set, sends a real message so
 * delivery is confirmed by seeing it arrive, not just by a 200 status.
 */
async function checkTelegram(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

  if (!token) {
    console.log('\ntelegram: TELEGRAM_BOT_TOKEN not set - skipping');
    return;
  }
  registerSecret(token);

  if (!chatId) {
    console.log('\ntelegram: TELEGRAM_BOT_TOKEN set, TELEGRAM_CHAT_ID not set yet.');
    console.log('  Send any message to your bot in Telegram, then rerun this check.');
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as {
        ok: boolean;
        description?: string;
        result?: { message?: { chat: { id: number; type: string; first_name?: string; title?: string } } }[];
      };
      if (!body.ok) {
        failures += 1;
        console.log(`  FAIL  ${redact(body.description ?? `HTTP ${res.status}`)}`);
        return;
      }
      const chats = new Map<number, string>();
      for (const update of body.result ?? []) {
        const chat = update.message?.chat;
        if (chat) chats.set(chat.id, chat.title ?? chat.first_name ?? chat.type);
      }
      if (chats.size === 0) {
        console.log('  no messages seen yet - send one to the bot and rerun');
        return;
      }
      for (const [id, label] of chats) {
        console.log(`  found chat: ${id}  (${label}) - copy this into TELEGRAM_CHAT_ID`);
      }
    } catch (error) {
      failures += 1;
      console.log(`  FAIL  ${redact(error instanceof Error ? error.message : String(error))}`);
    }
    return;
  }

  console.log('\ntelegram: sending a real test message - check your Telegram app for it.');
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `AlgoTest broker login - test message from npm run check (${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST)`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      console.log('  pass  message sent - go check Telegram');
    } else {
      failures += 1;
      console.log(`  FAIL  telegram returned ${res.status}: ${redact(await res.text())}`);
    }
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${redact(error instanceof Error ? error.message : String(error))}`);
  }
}
