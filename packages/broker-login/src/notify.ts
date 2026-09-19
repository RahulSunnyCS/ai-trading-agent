import type { TelegramConfig } from './config.js';
import { redact } from './secrets.js';
import type { BrokerResult, ResultStatus } from './brokers/types.js';

const IST = 'Asia/Kolkata';

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

// Plain-text emoji, not Markdown formatting: broker names and error strings contain
// characters that would break Telegram's parser and silently drop the whole message,
// so parse_mode is never set. Icons alone carry the "glance at the lock screen and
// know" signal without needing any markup.
const STATUS_ICON: Record<ResultStatus, string> = {
  OK: '✅', // logged in just now
  SKIPPED: '🔁', // was already logged in - nothing done
  FAIL: '❌',
};

// Failures first, so anything needing attention is visible without scrolling once
// there are more than a couple of brokers.
const STATUS_RANK: Record<ResultStatus, number> = { FAIL: 0, OK: 1, SKIPPED: 2 };

export function formatReport(results: BrokerResult[], runUrl: string | null): string {
  const ready = results.filter((r) => r.status === 'OK' || r.status === 'SKIPPED').length;
  const total = results.length;

  let verdict: string;
  if (total === 0) verdict = '🚨 Login never reached the broker list';
  else if (ready === total) verdict = `✅ All brokers ready (${ready}/${total})`;
  else if (ready === 0) verdict = `❌ All brokers failed (0/${total}) - check now`;
  else verdict = `⚠️ Partial (${ready}/${total}) - check now`;

  const lines = [verdict, `AlgoTest broker login, ${istTimestamp()} IST`, ''];

  const sorted = [...results].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  for (const result of sorted) {
    const detail = result.detail ? ` — ${result.detail}` : '';
    lines.push(`${STATUS_ICON[result.status]} ${result.name}${detail}`);
  }

  if (runUrl) lines.push('', `🔗 ${runUrl}`);
  return redact(lines.join('\n'));
}

export async function sendTelegram(telegram: TelegramConfig | null, text: string): Promise<void> {
  if (!telegram) {
    console.log('\n[telegram not configured, report below]\n' + text);
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegram.chatId,
        text,
        disable_web_page_preview: true,
      }),
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
