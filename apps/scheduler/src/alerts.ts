import { type TelegramConfig, registerSecret, sendText } from '@trading/notify';
import type { History } from './history.js';
import type { Job } from './jobs.js';
import type { RunResult } from './runner.js';
import { formatIst } from './schedule.js';

/** Where alerts go. Telegram in production; an array in tests. */
export type AlertSink = (text: string) => Promise<void>;

export function telegramSink(env: Record<string, string>): AlertSink {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (botToken) registerSecret(botToken);
  const config: TelegramConfig | null = botToken && chatId ? { botToken, chatId } : null;
  return (text) => sendText(config, text);
}

/** Exit codes the runner itself produces: the job never got to report anything. */
const RUNNER_CODES = new Set([124, 127]);

/**
 * After a run: alert at once on a failure (unless the job already alerts on
 * its own failures and actually got to run), and say so when a job recovers
 * from a previous failure. Successes stay quiet — they go in the summary.
 */
export async function alertResult(
  sink: AlertSink,
  job: Job,
  result: RunResult,
  history: History,
): Promise<void> {
  if (!result.ok) {
    if (job.alertsItself && !RUNNER_CODES.has(result.exitCode) && result.attempts > 0) return;
    await sink(
      [
        `❌ ${job.id} failed`,
        `Scheduler, ${formatIst(new Date())} IST`,
        '',
        `${job.description}: ${result.error ?? `exit ${result.exitCode}`}`,
        `Attempts: ${result.attempts}. Log: ${result.logPath}`,
        '',
        `Fix: ${job.fixHint}`,
      ].join('\n'),
    );
    return;
  }
  const before = history.previous(job.id, result.runId);
  if (before && before.exit_code !== null && before.exit_code !== 0) {
    await sink(`✅ ${job.id} recovered\nScheduler, ${formatIst(new Date())} IST`);
  }
}

export async function alertMissed(sink: AlertSink, job: Job, slot: Date): Promise<void> {
  await sink(
    [
      `⚠️ ${job.id} was missed`,
      `Scheduler, ${formatIst(new Date())} IST`,
      '',
      `It was due ${formatIst(slot)} IST, but the laptop was asleep or off, and it is now too late to catch up (window: ${job.catchUpHours} h).`,
      '',
      `Run it by hand if it still matters: ${job.fixHint}`,
    ].join('\n'),
  );
}
