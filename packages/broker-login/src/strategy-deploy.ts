import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sendText } from '@trading/notify';
import { type Locator, type Page, chromium } from 'playwright';
import { BASE_URL } from './algotest.js';
import {
  type Automation,
  type Book,
  type Broker,
  algotestDeployBrokers,
  algotestMultiplierRefusal,
  describeSource,
  readAutomation,
  uploadBooks,
} from './automation-settings.js';
import { normalizePhone, readTelegramConfig } from './config.js';
import {
  ACTIVATE_LEAD_SECONDS,
  BROKER_LABELS,
  type LiveState,
  type Pick,
  SETUP_PENDING,
  checkBrokerSheet,
  istMinutes,
  nothingOnAlgotest,
  parseLive,
  planDeploy,
  planSetup,
  repeating,
  secondsUntil,
} from './deploy-plan.js';
import { describe, dumpHtml, safeScreenshot } from './diagnose.js';
import { algotestLoginLocked } from './login-lock.js';
import { redact, registerSecret } from './secrets.js';
import { livePage } from './selectors.js';
import { stopHeld } from './stop-hold.js';
import { type Manifest, istToday } from './strategy-plan.js';
import { visibleWithin } from './wait.js';

/**
 * BL-138: deploy the day's recorded rotation picks on AlgoTest's /live, through the website. Built
 * ready but OFF: `--apply` needs `ALGOTEST_DEPLOY=on`; without it the run logs in, reads /live and
 * prints what it would deploy. The owner may never switch it on (2026-10-19).
 *
 *   tsx src/strategy-deploy.ts --latest t1 [--apply]       deploy (after the 09:16 pick)
 *   tsx src/strategy-deploy.ts --latest t1 --check          15:35: anything left repeating or running
 *   tsx src/strategy-deploy.ts --latest t1 --setup [--apply]  BL-197: each evening, after the upload,
 *       Setup Execution for the next session's picks (Trade monitoring on Candle Close); deploys
 *       nothing, so it needs ALGOTEST_UPLOAD=on rather than ALGOTEST_DEPLOY
 *
 * Only a recorded export for today (`obt rotation algotest-export`, source "recorded") is accepted.
 * Each pick is set up with AlgoTest's defaults as seen on 2026-10-19 (docs/algotest-execution.md §7:
 * multiplier 1, NRML legs, no execution day ticked, so the deploy is for today only), then
 * activated: "Activate" opens the broker sheet (BL-197, seen 2026-11-03), where every broker whose
 * AlgoTest row uploads the book is ticked, one instance each. If anything else appears, it stops,
 * screenshots and alerts, and never clicks it.
 */

const VIEWPORT = { width: 1440, height: 900 };

/** The IST days of the deploy ledger's rows (each `{at, name, ok, ...}`); a bad line is skipped. */
function ledgerDays(text: string): string[] {
  const days: string[] = [];
  for (const line of text.split('\n')) {
    try {
      const at = (JSON.parse(line) as { at?: unknown }).at;
      if (typeof at === 'string') days.push(istToday(new Date(at)));
    } catch {
      // a torn last line, or a blank one
    }
  }
  return days;
}

function entryOf(doc: unknown): number {
  const s = (doc as { strategy?: { EntryIndicators?: { Value?: unknown[] } } }).strategy;
  const node = s?.EntryIndicators?.Value?.[0] as
    | { Value?: { Parameters?: { Hour?: number; Minute?: number } } }
    | undefined;
  const p = node?.Value?.Parameters;
  if (p?.Hour === undefined || p.Minute === undefined) throw new Error('no entry time in the file');
  return p.Hour * 60 + p.Minute;
}

async function readLive(page: Page, opts: { brokers?: boolean } = {}): Promise<LiveState> {
  await page.goto(`${BASE_URL}/live`, { waitUntil: 'domcontentloaded' });
  await livePage.header(page).waitFor({ timeout: 30_000 });
  await livePage.anyRowCount(page).waitFor({ timeout: 30_000 });
  // the broker count renders after the rows; not shown in time = unread (planDeploy refuses)
  if (opts.brokers)
    await livePage
      .brokerCount(page)
      .waitFor({ timeout: 20_000 })
      .catch(() => undefined);
  return parseLive(await page.evaluate(() => document.body.innerText));
}

/** Too close to a pick's entry minute to activate it: that pick only; later picks still deploy. */
class TooLate extends Error {}

/** "HH:MM" of minutes after midnight. */
function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Open the pick's Setup Execution sheet, check AlgoTest's defaults, put Trade monitoring on Candle
 * Close (BL-197: the overall MTM stop then checks at each minute's close, as the backtest does; leg
 * stops stay on LTP) and save it.
 */
async function setupSheet(page: Page, pick: Pick): Promise<void> {
  const { name } = pick;
  await livePage.row(page, name).click();
  await livePage.setupExecution(page).click();
  const sheet = livePage.sheet(page, name);
  await sheet.waitFor({ timeout: 15_000 });

  // AlgoTest's defaults, checked inside the sheet rather than changed: 1 lot, NRML on every leg,
  // no execution day ticked (so the deploy is for today only).
  const multiplier = await sheet.locator('input[type=number]').first().inputValue();
  if (multiplier !== '1') throw new Error(`quantity multiplier is ${multiplier}, not 1`);
  const products = await sheet
    .locator('select')
    .evaluateAll((els) =>
      els.map((e) => (e as HTMLSelectElement).value).filter((v) => v.startsWith('ProductType.')),
    );
  if (!products.length || products.some((v) => v !== 'ProductType.NRML'))
    throw new Error(`leg product types ${products.join(', ')}, expected NRML`);
  const ticked = await sheet
    .locator('input[type=checkbox]')
    .evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).checked).length);
  if (ticked > 0) throw new Error(`${ticked} box(es) ticked in the sheet; expected none`);
  const time = (await livePage.executionTime(sheet).inputValue()).slice(0, 5);
  if (time !== hhmm(pick.entry))
    throw new Error(`strategy execution time ${time}, expected ${hhmm(pick.entry)}`);
  const candle = livePage.monitoring(sheet, 'on Candle Close');
  const radio = candle.locator('input[type=radio]');
  if (!(await radio.isChecked())) await candle.click();
  if (!(await radio.isChecked()))
    throw new Error('Trade monitoring did not switch to on Candle Close');

  await livePage.sheetSave(sheet).click();
  await sheet.waitFor({ state: 'hidden', timeout: 15_000 });
}

/** What /live shows for `name` after a stop, so nobody deploys it twice by hand. */
async function deployedState(page: Page, name: string, before: number): Promise<string> {
  const now = await readLive(page)
    .then((s) => s.rows.find((r) => r.name === name)?.deployed)
    .catch(() => undefined);
  return now === undefined
    ? '/live could not be read: check it before deploying this by hand, it may be live already'
    : now > before
      ? `/live shows ${now} Deployed (was ${before}): it IS deployed, do not deploy it again by hand`
      : `/live shows ${now} Deployed (was ${before}): not deployed`;
}

/**
 * Tick exactly the wanted brokers in the open broker sheet (BL-197). Each row's checkbox is
 * read-only and the row takes the click; every box is read back, so a click that missed stops.
 */
async function tickBrokers(sheet: Locator, brokers: readonly Broker[]): Promise<void> {
  const check = checkBrokerSheet(await sheet.innerText(), brokers);
  if (check.missing.length) throw new Error(`broker sheet lists no ${check.missing.join(', ')}`);
  if (check.notLoggedIn.length)
    throw new Error(`${check.notLoggedIn.join(', ')} not LOGGED IN on the broker sheet`);
  const wanted = new Set(brokers.map((b) => BROKER_LABELS[b] ?? b));
  const boxes = sheet.locator('input[type=checkbox][readonly]');
  for (let i = 0; i < (await boxes.count()); i++) {
    const box = boxes.nth(i);
    const row = box.locator('xpath=..');
    const label = (await row.innerText()).trim();
    const want = [...wanted].some((w) => label.startsWith(`${w} - `));
    const checked = () => box.evaluate((e) => (e as HTMLInputElement).checked);
    if ((await checked()) !== want) await row.click();
    if ((await checked()) !== want)
      throw new Error(`could not ${want ? 'tick' : 'untick'} "${label}" on the broker sheet`);
  }
  const ticked = await boxes.evaluateAll(
    (els) => els.filter((e) => (e as HTMLInputElement).checked).length,
  );
  if (ticked !== wanted.size)
    throw new Error(`${ticked} broker(s) ticked on the broker sheet, expected ${wanted.size}`);
}

async function deployOne(page: Page, pick: Pick, brokers: readonly Broker[]): Promise<string> {
  const { name } = pick;
  await setupSheet(page, pick);

  const before = (await readLive(page)).rows.find((r) => r.name === name)?.deployed ?? 0;
  // The plan checked the time at login; setting up may have taken a while, so check again.
  const left = secondsUntil(pick.entry);
  if (left < ACTIVATE_LEAD_SECONDS)
    throw new TooLate(`TOO LATE: ${left} s to its entry minute, not activated`);
  await livePage.row(page, name).click();
  await livePage.activate(page).click();

  // BL-197: Activate opens the broker sheet (seen 2026-11-03). Anything else is unknown: stop.
  const sheet = livePage.brokerSheet(page, name);
  if (!(await visibleWithin(sheet, 8_000))) {
    const popup = livePage.popup(page).first();
    const raw = (await visibleWithin(popup, 1_000))
      ? await popup.innerText({ timeout: 1_000 }).catch(() => '(text not readable)')
      : '(nothing opened)';
    const text = raw.replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(
      `Activate did not open the broker sheet: ${text}. ${await deployedState(page, name, before)}`,
    );
  }
  await tickBrokers(sheet, brokers);
  if (secondsUntil(pick.entry) < ACTIVATE_LEAD_SECONDS) {
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
    await sheet.waitFor({ state: 'hidden', timeout: 15_000 });
    throw new TooLate('TOO LATE: its entry minute came while choosing brokers, not activated');
  }
  const go = livePage.brokerSheetActivate(sheet);
  const label = (await go.innerText()).trim();
  if (label !== `Activate on ${brokers.length} Broker${brokers.length === 1 ? '' : 's'}`)
    throw new Error(
      `the broker sheet's button reads "${label}", expected ${brokers.length} broker(s)`,
    );
  await go.click();
  await sheet.waitFor({ state: 'hidden', timeout: 15_000 });

  // Nothing opened after the sheet on 2026-11-03: anything that does now is unknown, never clicked.
  const popup = livePage.popup(page).first();
  if (await visibleWithin(popup, 3_000)) {
    const raw = await popup.innerText({ timeout: 1_000 }).catch(() => '(text not readable)');
    const text = raw.replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(
      `the broker sheet's Activate opened something not yet seen, not confirmed: ${text}. ${await deployedState(page, name, before)}`,
    );
  }
  // /live may lag the sheet: read it back up to three times before calling it a failure
  let after = before;
  for (let i = 0; i < 3 && after !== before + brokers.length; i++) {
    if (i) await page.waitForTimeout(3_000);
    after = (await readLive(page)).rows.find((r) => r.name === name)?.deployed ?? 0;
  }
  if (after !== before + brokers.length)
    throw new Error(
      `/live shows ${after} Deployed after Activate (was ${before}), expected ${before + brokers.length}: check it`,
    );
  const on = brokers.map((b) => BROKER_LABELS[b] ?? b).join(' + ');
  return `deployed on ${on} (${after} Deployed)`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      latest: { type: 'string' },
      apply: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      setup: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
  });
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (values.setup && values.check) {
    console.error('--setup and --check do not go together');
    return 64;
  }
  // BL-197: Setup Execution deploys nothing; it belongs to the upload and its switch
  const gate = values.setup ? 'ALGOTEST_UPLOAD' : 'ALGOTEST_DEPLOY';
  if ((values.apply || values.check) && process.env[gate]?.trim().toLowerCase() !== 'on') {
    console.log(
      `${gate} is not "on": nothing ${values.setup ? 'set up' : 'deployed'} (dry run without --apply)`,
    );
    return 0;
  }
  // BL-143 Phase 4: a confirmed stop holds every deploy until the owner resumes.
  const held = values.apply ? stopHeld() : null;
  if (held) {
    console.log(`AlgoTest deploy ${held}`);
    return 0;
  }
  // BL-140: the dashboard's "Automated deployment" master switch must be on as well. The settings
  // are read once. A deploy fails closed when they cannot be read (readAutomation throws); the 15:35
  // check fails open (it runs), since it only reads /live and is the safety net.
  let automation: Automation | null = null;
  try {
    automation = readAutomation();
  } catch (error) {
    if (!values.check) throw error;
    console.error(`automation settings unreadable (${String(error)}): the check runs anyway`);
  }
  if (values.apply && automation) {
    if (!values.setup && !automation.masters.deploy) {
      console.log(`Automated deployment is off (${describeSource(automation)}): nothing deployed`);
      return 0;
    }
    // BL-140 Phase 4: the deployer only checks the sheet's multiplier, never sets it
    const refusal = algotestMultiplierRefusal(automation);
    if (refusal) {
      console.log(`${refusal} (${describeSource(automation)})`);
      return 0;
    }
  }
  let dir = values.dir;
  if (!dir && values.latest) {
    const root = process.env.TRADING_DATA_ROOT?.trim();
    if (!root) {
      console.error('--latest needs TRADING_DATA_ROOT');
      return 1;
    }
    const pointer = join(root, 'rotation', 'algotest', `latest-${values.latest}.json`);
    dir = (JSON.parse(await readFile(pointer, 'utf8')) as { dir: string }).dir;
  }
  if (!dir) {
    console.error('usage: --dir <export folder> | --latest <book> [--apply | --check | --setup]');
    return 64;
  }
  const manifest = JSON.parse(
    await readFile(join(resolve(dir), 'manifest.json'), 'utf8'),
  ) as Manifest;
  const today = istToday();
  if (values.setup) {
    if (manifest.day < today) {
      console.error(`the export is for ${manifest.day}, a past session: nothing to set up`);
      return 1;
    }
  } else if (!values.check && (manifest.source !== 'recorded' || manifest.day !== today)) {
    console.error(
      `the export is ${manifest.source} for ${manifest.day}, not today's recorded picks`,
    );
    return 1;
  }
  // BL-140: no login at all when the settings give AlgoTest nothing of the tool's to deploy or check.
  if (
    values.setup &&
    automation &&
    !(uploadBooks(automation, 'algotest') as string[]).includes(manifest.book)
  ) {
    console.log(
      `no AlgoTest row in Settings › Automation uploads the ${manifest.book.toUpperCase()} list: nothing to set up (${describeSource(automation)}); AlgoTest not logged in`,
    );
    return 0;
  }
  if ((values.apply || values.check) && automation && !values.setup) {
    const uploads = uploadBooks(automation, 'algotest');
    const ledger = join(resolve(dir), '..', '..', 'deploy-ledger.jsonl');
    const nothing = nothingOnAlgotest(
      uploads,
      manifest.book,
      values.check,
      existsSync(ledger) ? ledgerDays(await readFile(ledger, 'utf8')) : [],
      today,
    );
    if (nothing) {
      console.log(`${nothing} (${describeSource(automation)}); AlgoTest not logged in`);
      // An AlgoTest row uploading another list is deployed by no job: say so, never silently.
      const other = values.apply ? uploads.filter((b) => b !== manifest.book) : [];
      if (other.length) {
        await sendText(
          readTelegramConfig(),
          `⚠️ AlgoTest: Settings › Automation uploads the ${other.map((b) => b.toUpperCase()).join(', ')} list, but the 09:16 deploy handles ${manifest.book.toUpperCase()} only: deploy those by hand on /live`,
          'broker.algotest',
        ).catch(() => undefined);
      }
      return 0;
    }
  }
  // BL-197: one instance per AlgoTest row that uploads this book, ticked on the broker sheet
  const brokers: Broker[] = automation
    ? algotestDeployBrokers(automation, manifest.book as Book)
    : [];
  if (values.apply && !values.setup && !values.check && !brokers.length) {
    console.error(
      `no AlgoTest row uploads the ${manifest.book.toUpperCase()} list: no broker to deploy to`,
    );
    return 1;
  }
  const picks: Pick[] = [];
  for (const s of manifest.strategies) {
    const doc = JSON.parse(await readFile(join(resolve(dir), s.file), 'utf8'));
    picks.push({ name: s.name, entry: entryOf(doc) });
  }

  const phone = process.env.ALGOTEST_PHONE?.trim();
  const password = process.env.ALGOTEST_PASSWORD?.trim();
  if (!phone || !password) {
    console.error('ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env');
    return 1;
  }
  registerSecret(password);
  const what = values.setup ? `setup for ${manifest.day}` : values.check ? '15:35 check' : 'deploy';
  const label = `AlgoTest ${manifest.book.toUpperCase()} ${what}${values.setup ? '' : ` ${today}`}`;
  const browser = await chromium.launch({ headless: !values.headed });
  const page = await (
    await browser.newContext({ viewport: VIEWPORT, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
  ).newPage();
  page.setDefaultTimeout(20_000);
  const lines: string[] = [];
  let failed = false;

  try {
    await algotestLoginLocked(page, { phone: normalizePhone(phone), password }, 'strategy-deploy');
    // setting up needs no broker; the deploy and the 15:35 check read the count
    const live = await readLive(page, { brokers: !values.setup });
    if (values.setup) {
      const p = planSetup(picks, live);
      if (p.deployed.length) lines.push(`already deployed, left alone: ${p.deployed.join(', ')}`);
      if (p.missing.length) lines.push(`NOT IN ALGOTEST, not set up: ${p.missing.join(', ')}`);
      if (p.setup.length) lines.push(`set up: ${p.setup.map((d) => d.name).join(', ')}`);
      failed = p.missing.length > 0;
      console.log(`${label}${values.apply ? '' : ' (dry run)'}\n${lines.join('\n')}`);
      if (values.apply) {
        for (const pick of p.setup) {
          try {
            await setupSheet(page, pick);
            const row = (await readLive(page)).rows.find((r) => r.name === pick.name);
            if (!row || row.status === SETUP_PENDING)
              throw new Error(`still "${row?.status ?? 'not listed'}" after saving the sheet`);
            lines.push(`✅ ${pick.name}: ${row.status} (Candle Close, ${hhmm(pick.entry)})`);
          } catch (error) {
            failed = true;
            await safeScreenshot(page, 'setup-failed');
            await dumpHtml(page, 'setup-failed');
            lines.push(`❌ ${pick.name}: ${describe(error)}`);
            // a sheet that did not behave stops the run: nothing else is set up blind
            break;
          }
        }
      }
    } else if (values.check) {
      const again = repeating(live);
      if (again.length) {
        failed = true;
        lines.push(`repeat days ticked (would trade again): ${again.join(', ')}`);
      } else lines.push('no tool strategy repeats tomorrow');
    } else {
      const p = planDeploy(picks, live, istMinutes());
      if (p.refused) {
        lines.push(`refused: ${p.refused}`);
        // what /live showed, for the next look (2026-11-03's "0/0" left nothing behind)
        await safeScreenshot(page, 'deploy-refused');
        await dumpHtml(page, 'deploy-refused');
      }
      if (p.already.length) lines.push(`already deployed: ${p.already.join(', ')}`);
      if (p.deploy.length)
        lines.push(
          `deploy: ${p.deploy.map((d) => d.name).join(', ')} on ${brokers.map((b) => BROKER_LABELS[b] ?? b).join(' + ') || '(no broker)'}`,
        );
      if (p.tooLate.length) lines.push(`TOO LATE, not deployed: ${p.tooLate.join(', ')}`);
      if (p.missing.length) lines.push(`NOT IN ALGOTEST, not deployed: ${p.missing.join(', ')}`);
      if (p.noSlot.length) lines.push(`NO FREE SLOT, not deployed: ${p.noSlot.join(', ')}`);
      failed = p.refused !== null || p.tooLate.length + p.missing.length + p.noSlot.length > 0;
      console.log(`${label}${values.apply ? '' : ' (dry run)'}\n${lines.join('\n')}`);
      if (values.apply) {
        const ledger = join(resolve(dir), '..', '..', 'deploy-ledger.jsonl');
        for (const pick of p.deploy) {
          try {
            const verdict = await deployOne(page, pick, brokers);
            lines.push(`✅ ${pick.name}: ${verdict}`);
            await appendFile(
              ledger,
              `${JSON.stringify({ at: new Date().toISOString(), name: pick.name, ok: true, verdict })}\n`,
            );
          } catch (error) {
            failed = true;
            await safeScreenshot(page, 'deploy-failed');
            await dumpHtml(page, 'deploy-failed');
            lines.push(`❌ ${pick.name}: ${describe(error)}`);
            await appendFile(
              ledger,
              `${JSON.stringify({ at: new Date().toISOString(), name: pick.name, ok: false, error: describe(error) })}\n`,
            );
            // too late for this pick only: the later ones still have time. Any other surprise
            // stops the run, so nothing else is deployed blind.
            if (!(error instanceof TooLate)) break;
          }
        }
      }
    }
  } catch (error) {
    failed = true;
    lines.push(`❌ ${describe(error)}`);
    await safeScreenshot(page, 'deploy-fatal');
  } finally {
    await browser.close().catch(() => undefined);
  }

  if (values.apply || (values.check && failed)) {
    const head = failed
      ? `⚠️ ${label}: check AlgoTest ${values.setup ? 'before the morning' : 'now'}`
      : `✅ ${label}`;
    await sendText(
      readTelegramConfig(),
      redact([head, ...lines].join('\n')),
      'broker.algotest',
    ).catch(() => undefined);
  }
  console.log(lines.join('\n'));
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code));
