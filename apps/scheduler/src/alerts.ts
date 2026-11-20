import { type TelegramConfig, registerSecret, sendText } from '@trading/notify';
import type { History } from './history.js';
import type { Job } from './jobs.js';
import type { RunResult } from './runner.js';
import { formatIst } from './schedule.js';

/** Where alerts go. Telegram in production; an array in tests. `type` overrides the sink's. */
export type AlertSink = (text: string, type?: string) => Promise<void>;

/**
 * `type` ties the message to a switch on the Notifications page (packages/notify prefs.ts).
 * BL-173: the failure, missed and recovered alerts have their own types
 * (`scheduler.failure` / `.missed` / `.recovered`); every one of them is a failure except
 * "recovered", which is off by default (the owner, 2026-10-28).
 */
export function telegramSink(env: Record<string, string>, type?: string): AlertSink {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (botToken) registerSecret(botToken);
  registerContractNoteSecrets(env.BROKER_ACCOUNTS_JSON);
  const config: TelegramConfig | null = botToken && chatId ? { botToken, chatId } : null;
  return async (text, override) => {
    await sendText(config, text, override ?? type);
  };
}

/**
 * The contract-notes run's mailbox and PDF passwords (BL-168), so no alert can carry one. A value
 * that does not parse is the run's own error to report; nothing to register.
 */
export function registerContractNoteSecrets(raw: string | undefined): void {
  if (!raw) return;
  try {
    const config = JSON.parse(raw) as Array<{
      emailPassword?: string;
      accounts?: Array<{ pdfPassword?: string }>;
    }>;
    for (const mailbox of config) {
      registerSecret(mailbox.emailPassword);
      for (const account of mailbox.accounts ?? []) registerSecret(account.pdfPassword);
    }
  } catch {
    // not JSON: run.js says so
  }
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
  if (!result.ok && job.chain) {
    await alertChain(sink, job, result);
    return;
  }
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
      'scheduler.failure',
    );
    return;
  }
  const before = history.previous(job.id, result.runId);
  if (before && before.exit_code !== null && before.exit_code !== 0) {
    await sink(
      `✅ ${job.id} recovered\nScheduler, ${formatIst(new Date())} IST`,
      'scheduler.recovered',
    );
  }
}

/**
 * BL-234: a chain's failure is ONE message that names each step that failed or was skipped, with
 * that step's own fix and what passed. A step that sends its own Telegram (`alertsItself`) and
 * really ran is left out, as a whole job that does so is; when nothing else is left, nothing is sent.
 */
async function alertChain(sink: AlertSink, job: Job, result: RunResult): Promise<void> {
  const steps = result.steps ?? [];
  const problems = steps.filter(
    (s) => s.status === 'failed' || s.status === 'skipped' || (s.status === 'late' && s.alertLate),
  );
  const loud = problems.filter(
    (s) =>
      !(
        s.alertsItself &&
        s.status === 'failed' &&
        !RUNNER_CODES.has(s.exitCode ?? 0) &&
        s.attempts > 0
      ),
  );
  // no step ran (a refused resume, an unknown step): the run's own error is the message
  if (problems.length > 0 && loud.length === 0) return;
  const passed = steps.filter((s) => s.status === 'ok' || s.status === 'carried').map((s) => s.id);
  await sink(
    [
      `❌ ${job.id} failed${problems.length > 0 ? ` (${problems.length} of ${steps.length} steps)` : ''}`,
      `Scheduler, ${formatIst(new Date())} IST`,
      '',
      job.description,
      ...(loud.length > 0
        ? loud.map(
            (s) =>
              `• ${s.id}: ${s.error ?? `exit ${s.exitCode}`}${s.status === 'failed' ? `\n  Fix: ${s.fixHint}` : ''}`,
          )
        : [result.error ?? `exit ${result.exitCode}`]),
      ...(passed.length > 0 ? ['', `Passed: ${passed.join(', ')}`] : []),
      '',
      `Log: ${result.logPath}`,
      `Run again from the failed step with: bun run --filter @ata/scheduler jobs run ${job.id} --resume`,
    ].join('\n'),
    'scheduler.failure',
  );
}

export async function alertMissed(sink: AlertSink, job: Job, slot: Date): Promise<void> {
  await alertMissedAll(sink, [{ job, slot }]);
}

/**
 * BL-173: every slot found missed in one pass (a wake-up after a sleep finds several) as ONE
 * message, instead of one per slot.
 */
export async function alertMissedAll(
  sink: AlertSink,
  missed: Array<{ job: Job; slot: Date }>,
): Promise<void> {
  if (!missed.length) return;
  if (missed.length === 1) {
    const [{ job, slot }] = missed as [{ job: Job; slot: Date }];
    await sink(
      [
        `⚠️ ${job.id} was missed`,
        `Scheduler, ${formatIst(new Date())} IST`,
        '',
        `It was due ${formatIst(slot)} IST, but the laptop was asleep or off, and it is now too late to catch up (window: ${job.catchUpHours} h).`,
        '',
        `Run it by hand if it still matters: ${job.fixHint}`,
      ].join('\n'),
      'scheduler.missed',
    );
    return;
  }
  await sink(
    [
      `⚠️ ${missed.length} jobs were missed`,
      `Scheduler, ${formatIst(new Date())} IST`,
      '',
      'The laptop was asleep or off, and it is now too late to catch these up:',
      ...missed.map(({ job, slot }) => `• ${job.id} (due ${formatIst(slot)} IST)`),
      '',
      "Run any that still matters by hand: the Jobs page has each one's fix.",
    ].join('\n'),
    'scheduler.missed',
  );
}
