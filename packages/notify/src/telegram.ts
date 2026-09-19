import { redact } from './secrets.js';
import type { Action, Notification, Severity, TelegramConfig } from './types.js';

const SEVERITY_ICON: Record<Severity, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
  action_required: '🔔',
};

const IST = 'Asia/Kolkata';

/** Every message is stamped in IST — the only timezone this system trades in. */
export function istTimestamp(): string {
  return new Date().toLocaleString('en-IN', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function render(n: Notification): string {
  const lines = [`${SEVERITY_ICON[n.severity]} ${n.title}`, `${n.source}, ${istTimestamp()} IST`];
  if (n.body) lines.push('', n.body);
  if (n.runUrl) lines.push('', `🔗 ${n.runUrl}`);
  return lines.join('\n');
}

function keyboard(actions: Action[] | undefined) {
  if (!actions?.length) return undefined;
  return { inline_keyboard: [actions.map((a) => ({ text: a.label, callback_data: a.data }))] };
}

/**
 * POSTs to Telegram. Never throws — a notification failing must not take down
 * the thing it was reporting on.
 *
 * `parse_mode` is deliberately never set. Broker names and error strings
 * contain characters that break Telegram's Markdown parser, and Telegram's
 * failure mode is to silently drop the entire message rather than complain.
 * Icons carry the signal instead of markup.
 *
 * Every outbound string passes through redact() — this is the last point at
 * which a credential can be stopped from leaving the process.
 */
async function post(config: TelegramConfig, body: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, disable_web_page_preview: true, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.error(`  telegram returned ${response.status}: ${redact(await response.text())}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  telegram send failed: ${redact(message)}`);
  }
}

/** Structured send. Prefer this — it renders consistently across every caller. */
export async function send(config: TelegramConfig | null, n: Notification): Promise<void> {
  const text = redact(render(n));
  if (!config) {
    console.log(`\n[telegram not configured, message below]\n${text}`);
    return;
  }
  await post(config, { text, reply_markup: keyboard(n.actions) });
}

/**
 * Escape hatch for a caller that builds its own layout — broker-login's report
 * is a sorted multi-broker table that does not fit title/body. Still redacted.
 */
export async function sendText(config: TelegramConfig | null, text: string): Promise<void> {
  const safe = redact(text);
  if (!config) {
    console.log(`\n[telegram not configured, message below]\n${safe}`);
    return;
  }
  await post(config, { text: safe });
}
