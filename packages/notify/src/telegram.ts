import { isEnabled } from './prefs.js';
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
async function post(
  config: TelegramConfig,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, disable_web_page_preview: true, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.error(`  telegram returned ${response.status}: ${redact(await response.text())}`);
      return false;
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  telegram send failed: ${redact(message)}`);
    return false;
  }
}

/**
 * What became of a message: Telegram accepted it, the owner switched its type off, Telegram is
 * not configured, or the send failed. A caller that must not lose a message (BL-143's loss
 * alert) marks it sent only when it was `sent` or `muted`, and tries again otherwise.
 */
export type SendOutcome = 'sent' | 'muted' | 'unconfigured' | 'failed';
/** Telegram refuses a message longer than this (characters). */
export const TELEGRAM_MAX_TEXT = 4096;

/** Structured send. Prefer this — it renders consistently across every caller. */
export async function send(config: TelegramConfig | null, n: Notification): Promise<SendOutcome> {
  const text = redact(render(n));
  if (!isEnabled(n.type)) {
    console.log(`\n[telegram: '${n.type}' is switched off, message below]\n${text}`);
    return 'muted';
  }
  if (!config) {
    console.log(`\n[telegram not configured, message below]\n${text}`);
    return 'unconfigured';
  }
  return (await post(config, { text, reply_markup: keyboard(n.actions) })) ? 'sent' : 'failed';
}

/**
 * Escape hatch for a caller that builds its own layout — broker-login's report
 * is a sorted multi-broker table that does not fit title/body. Still redacted.
 */
export async function sendText(
  config: TelegramConfig | null,
  text: string,
  type?: string,
): Promise<SendOutcome> {
  const safe = redact(text);
  if (!isEnabled(type)) {
    console.log(`\n[telegram: '${type}' is switched off, message below]\n${safe}`);
    return 'muted';
  }
  if (!config) {
    console.log(`\n[telegram not configured, message below]\n${safe}`);
    return 'unconfigured';
  }
  return (await post(config, { text: safe })) ? 'sent' : 'failed';
}

/**
 * For a message whose delivery matters (the stop button's report): never type-gated, cut into
 * parts of at most `TELEGRAM_MAX_TEXT` characters on line breaks, and true only when Telegram
 * accepted every part. False when not configured. Still redacted, still never throws.
 */
export async function sendTextChecked(
  config: TelegramConfig | null,
  text: string,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const safe = redact(text);
  if (!config) {
    console.log(`\n[telegram not configured, message below]\n${safe}`);
    return false;
  }
  let all = true;
  for (const part of splitText(safe)) {
    if (!(await post(config, { text: part }, fetchImpl))) all = false;
  }
  return all;
}

/** Parts of at most `max` characters, cut at line breaks where possible, numbered when several. */
export function splitText(text: string, max = TELEGRAM_MAX_TEXT - 96): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    let piece = line;
    for (;;) {
      const room = max - (cur ? cur.length + 1 : 0);
      if (piece.length <= room) {
        cur = cur ? `${cur}\n${piece}` : piece;
        break;
      }
      if (cur) {
        parts.push(cur);
        cur = '';
        continue;
      }
      parts.push(piece.slice(0, max));
      piece = piece.slice(max);
    }
  }
  if (cur || !parts.length) parts.push(cur);
  return parts.length > 1 ? parts.map((p, i) => `(${i + 1}/${parts.length})\n${p}`) : parts;
}
