import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sendText } from '@trading/notify';
import { type APIRequestContext, chromium } from 'playwright';
import { type Book, type Broker, effectiveRow } from './automation-settings.js';
import {
  type BrokerStop,
  type Kept,
  type StopExport,
  decide,
  parseBrokerStop,
  saved,
  stopExtra,
} from './broker-stop-plan.js';
import { normalizePhone, readTelegramConfig } from './config.js';
import { automationForSession, sessionFor } from './day-type.js';
import { describe } from './diagnose.js';
import { algotestLoginLocked } from './login-lock.js';
import { ALGOTEST_BROKER_ID } from './monitor-plan.js';
import { registerSecret } from './secrets.js';
import { ALGOTEST_API, csrfToken } from './strategy-delete.js';
import { istToday } from './strategy-plan.js';

/**
 * AlgoTest's daily book stop (owner, 2026-11-27): each AlgoTest row with "MTM SL" set in Settings ›
 * Automation gets that broker-level stop before the market opens, and it is read back. AlgoTest's
 * stop covers the broker's whole MTM, the owner's own strategies included, and must be set again
 * each day. Only the stop loss changes. After 09:15 nothing is written. Scheduler: the first step of
 * `algotest-activate` (08:11).
 *
 *   tsx src/broker-stop.ts [--apply] [--soft-fail] [--headed]
 *
 * Without --apply it logs in and prints what it would set. --apply needs ALGOTEST_DEPLOY=on.
 * --show only prints both brokers' stops as AlgoTest has them, whatever the settings say.
 */

const VIEWPORT = { width: 1440, height: 900 };
const LIMIT_MINUTES = 4;
const BROKERS: Broker[] = ['finvasia', 'angelone'];
const NAMES: Record<Broker, string> = { finvasia: 'Finvasia', angelone: 'Angel One' };
const rupee = (n: number | null) => (n === null ? 'none' : `₹${n.toLocaleString('en-IN')}`);

function istMinutes(now: Date = new Date()): number {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

async function readStop(
  request: APIRequestContext,
  csrf: string,
  broker: Broker,
): Promise<BrokerStop> {
  const response = await request.get(`${ALGOTEST_API}/brokers`, {
    headers: { 'X-CSRF-TOKEN-ACCESS': csrf },
    failOnStatusCode: false,
    timeout: 20_000,
  });
  if (!response.ok()) throw new Error(`AlgoTest /brokers answered ${response.status()}`);
  return parseBrokerStop(await response.json(), ALGOTEST_BROKER_ID[broker]);
}

async function writeStop(
  request: APIRequestContext,
  csrf: string,
  id: string,
  body: Kept & { StopLoss: number },
): Promise<void> {
  const response = await request.put(
    `${ALGOTEST_API}/update-broker-settings/v2/${id}?is_signal=false`,
    {
      headers: { 'X-CSRF-TOKEN-ACCESS': csrf },
      data: body,
      failOnStatusCode: false,
      timeout: 20_000,
    },
  );
  if (!response.ok()) throw new Error(`saving answered ${response.status()}`);
}

/** The extra the day's export puts on the stop; 0 with a note when it cannot be told. */
async function extraFor(book: Book): Promise<{ extra: number; note: string }> {
  const root = process.env.TRADING_DATA_ROOT?.trim();
  const pointer = root ? join(root, 'rotation', 'algotest', `latest-${book}.json`) : '';
  if (!pointer || !existsSync(pointer)) return { extra: 0, note: 'no export: Dir ×2 not added' };
  const { dir } = JSON.parse(await readFile(pointer, 'utf8')) as { dir: string };
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as StopExport;
  if (manifest.day !== istToday())
    return { extra: 0, note: `the export is for ${manifest.day}: Dir ×2 not added` };
  if (manifest.split) return { extra: 0, note: 'split list: Dir ×2 not added' };
  const docs = new Map<string, unknown>();
  for (const s of manifest.strategies)
    docs.set(s.name, JSON.parse(await readFile(join(dir, s.file), 'utf8')));
  return { extra: stopExtra(manifest, docs), note: '' };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'soft-fail': { type: 'boolean', default: false },
      show: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
  });
  if (existsSync('.env')) process.loadEnvFile('.env');
  const apply = values.apply && !values.show;
  const tell = async (text: string) => {
    console.log(text);
    if (apply) await sendText(readTelegramConfig(), text, 'broker.algotest').catch(() => undefined);
  };
  const lines: string[] = [];
  let failed = false;
  // The activation runs after this in the same job: a hung page must never use up its time.
  const watchdog = setTimeout(() => {
    setTimeout(() => process.exit(1), 20_000);
    void tell(
      `AlgoTest book stop: no answer in ${LIMIT_MINUTES} minutes. Check the stops on /live`,
    ).finally(() => process.exit(values['soft-fail'] ? 0 : 1));
  }, LIMIT_MINUTES * 60_000);
  watchdog.unref();
  try {
    if (apply && process.env.ALGOTEST_DEPLOY?.trim().toLowerCase() !== 'on') {
      console.log('ALGOTEST_DEPLOY is not "on": no stop set (dry run without --apply)');
      return 0;
    }
    const automation = await automationForSession(sessionFor(false));
    const wanted = BROKERS.flatMap((broker) => {
      const row = effectiveRow(automation, 'algotest', broker);
      return row.mtmSl === null && !values.show ? [] : [{ broker, row, mtmSl: row.mtmSl ?? 0 }];
    });
    if (!wanted.length) {
      console.log('no AlgoTest row in Settings › Automation has an MTM SL: nothing to do');
      return 0;
    }
    const phone = process.env.ALGOTEST_PHONE?.trim();
    const password = process.env.ALGOTEST_PASSWORD?.trim();
    if (!phone || !password)
      throw new Error('ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env');
    registerSecret(password);

    const browser = await chromium.launch({ headless: !values.headed });
    try {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await algotestLoginLocked(page, { phone: normalizePhone(phone), password }, 'broker-stop');
      const csrf = await csrfToken(context);
      for (const { broker, row, mtmSl } of wanted) {
        const name = NAMES[broker];
        try {
          if (values.show) {
            const now = await readStop(context.request, csrf, broker);
            lines.push(`${name}: stop ${rupee(now.stopLoss)}, kept ${JSON.stringify(now.kept)}`);
            continue;
          }
          const { extra, note } =
            row.dirBoost && row.list !== 'none' ? await extraFor(row.list) : { extra: 0, note: '' };
          const target = mtmSl + extra;
          const want = `${rupee(target)}${extra ? ` (${rupee(mtmSl)} + ${rupee(extra)} for Dir ×2)` : ''}`;
          const tail = note ? ` (${note})` : '';
          const before = await readStop(context.request, csrf, broker);
          const decision = decide(before, target, istMinutes());
          if (decision.kind === 'holds') {
            lines.push(`✅ ${name}: stop ${want} already set${tail}`);
          } else if (decision.kind === 'left') {
            failed = true;
            lines.push(
              `⚠️ ${name}: stop is ${rupee(before.stopLoss)}, rule says ${want}: ${decision.why}${tail}`,
            );
          } else if (!apply) {
            lines.push(`${name}: stop is ${rupee(before.stopLoss)}, would set ${want}${tail}`);
          } else {
            await writeStop(context.request, csrf, before.id, decision.body);
            // the web app waits before it reads the setting back; look for a short while
            let after = await readStop(context.request, csrf, broker);
            for (let i = 0; i < 5 && !saved(after, target, before); i++) {
              await page.waitForTimeout(3_000);
              after = await readStop(context.request, csrf, broker);
            }
            if (!saved(after, target, before))
              throw new Error(`saved ${want} but AlgoTest reads ${rupee(after.stopLoss)}`);
            lines.push(`✅ ${name}: stop set to ${want}, was ${rupee(before.stopLoss)}${tail}`);
          }
        } catch (error) {
          failed = true;
          lines.push(`❌ ${name}: ${describe(error)}. Check the stop on /live`);
        }
      }
    } finally {
      await browser.close();
    }
  } catch (error) {
    failed = true;
    lines.push(`❌ ${describe(error)}. Check the stops on /live`);
  }
  await tell(`AlgoTest book stop${apply ? '' : ' (dry run)'}\n${lines.join('\n')}`);
  return failed && !values['soft-fail'] ? 1 : 0;
}

process.exit(await main());
