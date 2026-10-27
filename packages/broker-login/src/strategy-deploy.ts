import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sendText } from '@trading/notify';
import { type Page, chromium } from 'playwright';
import { BASE_URL } from './algotest.js';
import {
  algotestMultiplierRefusal,
  describeSource,
  readAutomation,
  uploadBooks,
} from './automation-settings.js';
import { normalizePhone, readTelegramConfig } from './config.js';
import {
  ACTIVATE_LEAD_SECONDS,
  type LiveState,
  type Pick,
  istMinutes,
  nothingOnAlgotest,
  parseLive,
  planDeploy,
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
 *
 * Only a recorded export for today (`obt rotation algotest-export`, source "recorded") is accepted.
 * Each pick is set up with AlgoTest's defaults as seen on 2026-10-19 (docs/algotest-execution.md §7:
 * multiplier 1, NRML legs, no execution day ticked, so the deploy is for today only), then
 * activated. What "Activate" asks has not been seen yet: if anything appears after the click that
 * this script does not recognise, it stops, screenshots and alerts, and never clicks it.
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

async function readLive(page: Page): Promise<LiveState> {
  await page.goto(`${BASE_URL}/live`, { waitUntil: 'domcontentloaded' });
  await livePage.header(page).waitFor({ timeout: 30_000 });
  await livePage.anyRowCount(page).waitFor({ timeout: 30_000 });
  return parseLive(await page.evaluate(() => document.body.innerText));
}

/** Too close to a pick's entry minute to activate it: that pick only; later picks still deploy. */
class TooLate extends Error {}

async function deployOne(page: Page, pick: Pick): Promise<string> {
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

  await livePage.sheetSave(sheet).click();
  await sheet.waitFor({ state: 'hidden', timeout: 15_000 });

  const before = (await readLive(page)).rows.find((r) => r.name === name)?.deployed ?? 0;
  // The plan checked the time at login; setting up may have taken a while, so check again.
  const left = secondsUntil(pick.entry);
  if (left < ACTIVATE_LEAD_SECONDS)
    throw new TooLate(`TOO LATE: ${left} s to its entry minute, not activated`);
  await livePage.row(page, name).click();
  await livePage.activate(page).click();

  // Anything that pops up now (a broker choice, a confirmation) has never been seen: stop.
  const popup = livePage.popup(page).first();
  if (await visibleWithin(popup, 4_000)) {
    // the popup may already be gone again: never wait the page default for its text
    const raw = await popup.innerText({ timeout: 1_000 }).catch(() => '(text not readable)');
    const text = raw.replace(/\s+/g, ' ').slice(0, 200);
    // Activate may already have deployed it: say what /live shows, so nobody deploys it twice
    const now = await readLive(page)
      .then((s) => s.rows.find((r) => r.name === name)?.deployed)
      .catch(() => undefined);
    const state =
      now === undefined
        ? '/live could not be read: check it before deploying this by hand, it may be live already'
        : now > before
          ? `/live shows ${now} Deployed (was ${before}): it IS deployed, do not deploy it again by hand`
          : `/live shows ${now} Deployed (was ${before}): not deployed`;
    throw new Error(`Activate opened something not yet seen, not confirmed: ${text}. ${state}`);
  }
  const after = (await readLive(page)).rows.find((r) => r.name === name)?.deployed ?? 0;
  if (after <= before) throw new Error('not shown as deployed after Activate');
  return `deployed (${after} Deployed)`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      latest: { type: 'string' },
      apply: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
  });
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (
    (values.apply || values.check) &&
    process.env.ALGOTEST_DEPLOY?.trim().toLowerCase() !== 'on'
  ) {
    console.log('ALGOTEST_DEPLOY is not "on": nothing deployed (dry run without --apply)');
    return 0;
  }
  // BL-143 Phase 4: a confirmed stop holds every deploy until the owner resumes.
  const held = values.apply ? stopHeld() : null;
  if (held) {
    console.log(`AlgoTest deploy ${held}`);
    return 0;
  }
  // BL-140: the dashboard's "Automated deployment" master switch must be on as well.
  if (values.apply) {
    const automation = readAutomation();
    if (!automation.masters.deploy) {
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
    console.error('usage: --dir <export folder> | --latest <book> [--apply | --check]');
    return 64;
  }
  const manifest = JSON.parse(
    await readFile(join(resolve(dir), 'manifest.json'), 'utf8'),
  ) as Manifest;
  const today = istToday();
  if (!values.check && (manifest.source !== 'recorded' || manifest.day !== today)) {
    console.error(
      `the export is ${manifest.source} for ${manifest.day}, not today's recorded picks`,
    );
    return 1;
  }
  // BL-140: no login at all when the settings give AlgoTest nothing of the tool's to deploy or check.
  if (values.apply || values.check) {
    const automation = readAutomation();
    const ledger = join(resolve(dir), '..', '..', 'deploy-ledger.jsonl');
    const nothing = nothingOnAlgotest(
      uploadBooks(automation, 'algotest'),
      manifest.book,
      values.check,
      existsSync(ledger) ? ledgerDays(await readFile(ledger, 'utf8')) : [],
      today,
    );
    if (nothing) {
      console.log(`${nothing} (${describeSource(automation)}); AlgoTest not logged in`);
      return 0;
    }
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
  const label = `AlgoTest ${manifest.book.toUpperCase()} ${values.check ? '15:35 check' : 'deploy'} ${today}`;
  const browser = await chromium.launch({ headless: !values.headed });
  const page = await (
    await browser.newContext({ viewport: VIEWPORT, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
  ).newPage();
  page.setDefaultTimeout(20_000);
  const lines: string[] = [];
  let failed = false;

  try {
    await algotestLoginLocked(page, { phone: normalizePhone(phone), password }, 'strategy-deploy');
    const live = await readLive(page);
    if (values.check) {
      const again = repeating(live);
      if (again.length) {
        failed = true;
        lines.push(`repeat days ticked (would trade again): ${again.join(', ')}`);
      } else lines.push('no tool strategy repeats tomorrow');
    } else {
      const p = planDeploy(picks, live, istMinutes());
      if (p.refused) lines.push(`refused: ${p.refused}`);
      if (p.already.length) lines.push(`already deployed: ${p.already.join(', ')}`);
      if (p.deploy.length) lines.push(`deploy: ${p.deploy.map((d) => d.name).join(', ')}`);
      if (p.tooLate.length) lines.push(`TOO LATE, not deployed: ${p.tooLate.join(', ')}`);
      if (p.missing.length) lines.push(`NOT IN ALGOTEST, not deployed: ${p.missing.join(', ')}`);
      if (p.noSlot.length) lines.push(`NO FREE SLOT, not deployed: ${p.noSlot.join(', ')}`);
      failed = p.refused !== null || p.tooLate.length + p.missing.length + p.noSlot.length > 0;
      console.log(`${label}${values.apply ? '' : ' (dry run)'}\n${lines.join('\n')}`);
      if (values.apply) {
        const ledger = join(resolve(dir), '..', '..', 'deploy-ledger.jsonl');
        for (const pick of p.deploy) {
          try {
            const verdict = await deployOne(page, pick);
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
    const head = failed ? `⚠️ ${label}: check AlgoTest now` : `✅ ${label}`;
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
