import type { Config } from './config.js';
import { redact } from './secrets.js';
import type { BrokerResult } from './brokers/types.js';

const IST = 'Asia/Kolkata';

function istTimestamp(): string {
  return new Date().toLocaleString('en-IN', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatReport(results: BrokerResult[], runUrl: string | null): string {
  const ready = results.filter((r) => r.status === 'OK' || r.status === 'SKIPPED').length;
  const total = results.length;

  let verdict: string;
  if (total === 0) verdict = 'FAILED - login never reached the broker list';
  else if (ready === total) verdict = `OK ${ready}/${total}`;
  else if (ready === 0) verdict = `FAILED 0/${total} - check now`;
  else verdict = `PARTIAL ${ready}/${total}`;

  const lines = [`${verdict} - AlgoTest broker login, ${istTimestamp()} IST`];

  for (const result of results) {
    const detail = result.detail ? `  ${result.detail}` : '';
    lines.push(`${result.status.padEnd(7)} ${result.name.padEnd(12)}${detail}`);
  }

  if (runUrl) lines.push(`Run: ${runUrl}`);
  // Plain text, not Markdown: broker names and error strings contain characters that
  // break Telegram's parser and would silently drop the whole message.
  return redact(lines.join('\n'));
}

export async function sendTelegram(config: Config, text: string): Promise<void> {
  if (!config.telegram) {
    console.log('\n[telegram not configured, report below]\n' + text);
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      console.error(`  telegram returned ${response.status}: ${redact(await response.text())}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  telegram send failed: ${redact(message)}`);
  }
}
