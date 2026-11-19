import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sendText } from '@trading/notify';
import { settingsPath } from './automation-settings.js';
import { readTelegramConfig } from './config.js';
import {
  type LoginStatus,
  combineReports,
  loginLine,
  switchOnNotRun,
} from './morning-report-plan.js';
import { istToday } from './strategy-plan.js';

/** The morning-open chain's report file for today, beside the scheduler's other state. */
export function chainReportPath(day: string = istToday()): string {
  return join(dirname(settingsPath()), 'morning-open', `report-${day}.jsonl`);
}

/**
 * BL-172: send the 08:10 switch-on's account reports as one Telegram message, then remove the
 * file. Run by the 08:10 `quantiply-deploy` job after both accounts (now the `morning-open` chain's steps):
 *
 *   tsx src/morning-report.ts <report file> [<accounts expected>] [--evening]
 *
 * `--evening` (BL-173, the 16:45 upload): headed "Quantiply evening upload", and nothing is sent
 * when no account wrote anything (only failures, credits spent or a changed list are written).
 *
 * `--chain <accounts expected>` (BL-234 Phase 4, the last step of the `morning-open` chain): the file is
 * today's `chainReportPath()` (`--path` prints it for the switch-on step) and may not exist, since that step
 * may not have run; the message then says so and still carries the login line.
 */
async function main(): Promise<number> {
  // `--path`: print today's chain report file (the switch-on step's MORNING_REPORT_FILE)
  if (process.argv[2] === '--path') {
    const path = chainReportPath();
    await mkdir(dirname(path), { recursive: true });
    console.log(path);
    return 0;
  }
  const chain = process.argv.includes('--chain');
  const file = chain ? chainReportPath() : process.argv[2];
  if (!file) {
    console.error('usage: morning-report.ts <report file>');
    return 64;
  }
  let text = await readFile(file, 'utf8').catch(() => null);
  const ranNothing = text === null;
  let login: string | null = null;
  const evening = process.argv.includes('--evening');
  let expected = evening ? 0 : Number(process.argv[3] ?? 0) || 0;
  if (!evening) {
    // BL-173: the 08:02 login's outcome is this message's first line (its own report goes
    // only on a failure)
    const statusFile = join(dirname(settingsPath()), 'broker-login', `${istToday()}.json`);
    const status = await readFile(statusFile, 'utf8')
      .then((t) => JSON.parse(t) as LoginStatus)
      .catch(() => null);
    const line = loginLine(status);
    login = line;
    if (line) {
      text = `${JSON.stringify({ text: line })}\n${text ?? ''}`;
      expected += 1;
    }
  }
  const message = evening
    ? combineReports(text, istToday(), 0, 'Quantiply evening upload', true)
    : chain && ranNothing
      ? switchOnNotRun(istToday(), login)
      : combineReports(text, istToday(), expected);
  if (message === null) {
    console.log('nothing worth a message');
    await rm(file, { force: true });
    return 0;
  }
  console.log(message);
  const sent = await sendText(readTelegramConfig(), message, 'broker.quantiply')
    .then(() => true)
    .catch(() => false);
  await rm(file, { force: true });
  return sent ? 0 : 1;
}

main().then((code) => process.exit(code));
