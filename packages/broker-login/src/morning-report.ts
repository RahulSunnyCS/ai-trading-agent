import { readFile, rm } from 'node:fs/promises';
import { sendText } from '@trading/notify';
import { readTelegramConfig } from './config.js';
import { combineReports } from './morning-report-plan.js';
import { istToday } from './strategy-plan.js';

/**
 * BL-172: send the 08:10 switch-on's account reports as one Telegram message, then remove the
 * file. Run by the `quantiply-deploy` job after both accounts:
 *
 *   tsx src/morning-report.ts <report file> [<accounts expected>]
 */
async function main(): Promise<number> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: morning-report.ts <report file>');
    return 64;
  }
  const text = await readFile(file, 'utf8').catch(() => null);
  const expected = Number(process.argv[3] ?? 0) || 0;
  const message = combineReports(text, istToday(), expected);
  console.log(message);
  const sent = await sendText(readTelegramConfig(), message, 'broker.quantiply')
    .then(() => true)
    .catch(() => false);
  await rm(file, { force: true });
  return sent ? 0 : 1;
}

main().then((code) => process.exit(code));
