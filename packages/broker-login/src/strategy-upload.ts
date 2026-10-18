import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sendText } from '@trading/notify';
import { type Page, type Response, chromium } from 'playwright';
import { BASE_URL, algotestLogin } from './algotest.js';
import { normalizePhone, readTelegramConfig } from './config.js';
import { describe, dumpHtml, safeScreenshot } from './diagnose.js';
import { redact, registerSecret } from './secrets.js';
import {
  type LedgerRow,
  type Manifest,
  type Mode,
  type Wanted,
  comparable,
  istToday,
  namesIn,
  needsAttention,
  parseLedger,
  plan,
  sha256,
  summary,
} from './strategy-plan.js';

/**
 * BL-137 Phase 3: put the day's rotation picks into AlgoTest as saved strategies, through the
 * website (AlgoTest support OK'd automating one's own account, 2026-10-19). Never deploys.
 *
 *   tsx src/strategy-upload.ts --dir <export folder> --mode evening|topup [--apply] [--allow-delete]
 *
 * `--dir` is a folder written by `obt rotation algotest-export` (manifest.json + one .algtst per
 * pick). Without `--apply` it logs in, reads what AlgoTest has and prints the plan, changing
 * nothing. Deleting also needs `--allow-delete` until the delete dialog has been seen in a
 * supervised run. `ALGOTEST_UPLOAD=off` stops it before login. The ledger (`--ledger`, default
 * `<dir>/../../ledger.jsonl`, i.e. TRADING_DATA_ROOT/rotation/algotest/ledger.jsonl) records every
 * upload and delete; only strategies in it are ever deleted.
 *
 * Website steps, as seen on 2026-10-19 (BL-137 Log): /backtest at desktop width has a hidden file
 * input (accept ".algtst,.json") behind "Import .algtst"; "Save Strategy" opens "Save New
 * Strategy" with the name filled in; "Done" saves (`api.algotest.in/strategy`, toast "Strategy
 * Saved"); "Export .algtst" downloads the saved strategy, which is the read-back. /live lists each
 * saved strategy with "<n> Deployed".
 */

const VIEWPORT = { width: 1440, height: 900 };

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function existingNames(page: Page): Promise<Set<string>> {
  const listed = page.waitForResponse(
    (r: Response) => /api\.algotest\.in\/strategies(\?|$)/.test(r.url()) && r.ok(),
    { timeout: 30_000 },
  );
  await page.goto(`${BASE_URL}/backtest`, { waitUntil: 'domcontentloaded' });
  return namesIn(await (await listed).json());
}

/** Names AlgoTest shows as deployed on /live. A row that cannot be read counts as deployed. */
async function deployedNames(page: Page, candidates: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!candidates.length) return out;
  await page.goto(`${BASE_URL}/live`, { waitUntil: 'domcontentloaded' });
  await page
    .getByText('Activation', { exact: true })
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  for (const name of candidates) {
    const row = page
      .locator('div')
      .filter({ hasText: name })
      .filter({ hasText: /\d+ Deployed/ })
      .last();
    const text = await row.innerText({ timeout: 5_000 }).catch(() => '');
    const n = /(\d+) Deployed/.exec(text);
    if (!n || Number(n[1]) > 0) out.add(name);
  }
  return out;
}

async function freshBuilder(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/backtest`, { waitUntil: 'domcontentloaded' });
  const importButton = page.getByText('Import .algtst');
  if (!(await importButton.isVisible({ timeout: 10_000 }).catch(() => false))) {
    await page.getByText('New Strategy').first().click();
    await importButton.waitFor({ timeout: 15_000 });
  }
}

/** Import, save under `w.name`, then export it back and compare. Returns the read-back verdict. */
async function uploadOne(page: Page, w: Wanted, sent: unknown): Promise<string> {
  await freshBuilder(page);
  await page.locator('input[type=file][accept*=".algtst"]').setInputFiles(w.file);
  await page.getByText(w.name, { exact: true }).first().waitFor({ timeout: 15_000 });

  await page.getByRole('button', { name: /Save Strategy/ }).click();
  await page.getByText('Save New Strategy').waitFor({ timeout: 10_000 });
  const field = page.getByText('Strategy Name:').locator('xpath=following::input[1]');
  await field.fill(w.name);
  const saved = page.waitForResponse(
    (r: Response) =>
      /api\.algotest\.in\/strategy(\?|$)/.test(r.url()) && r.request().method() !== 'GET',
    { timeout: 20_000 },
  );
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const response = await saved;
  if (!response.ok()) throw new Error(`save answered ${response.status()}`);
  await page.getByText('Strategy Saved').waitFor({ timeout: 10_000 });

  const download = page.waitForEvent('download', { timeout: 20_000 });
  await page.getByText('Export .algtst').click();
  const path = await (await download).path();
  const back = JSON.parse(await readFile(path, 'utf8'));
  return comparable(back) === comparable(sent) ? 'read back: identical' : 'READ-BACK DIFFERS';
}

async function deleteOne(page: Page, name: string): Promise<void> {
  await page.goto(`${BASE_URL}/backtest`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Search Strategies').fill(name);
  const row = page.locator('div').filter({ hasText: name }).last();
  await row.locator('svg, button').last().click();
  const deleted = page.waitForResponse(
    (r: Response) =>
      /api\.algotest\.in\/strateg/.test(r.url()) && r.request().method() === 'DELETE',
    { timeout: 20_000 },
  );
  await page.getByText('Delete', { exact: true }).last().click();
  const confirm = page.getByRole('button', { name: /^(Delete|Yes|Confirm)/ }).last();
  if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.click();
  const response = await deleted;
  if (!response.ok()) throw new Error(`delete answered ${response.status()}`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      latest: { type: 'string' },
      mode: { type: 'string' },
      ledger: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'allow-delete': { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
  });
  if (values.mode !== 'evening' && values.mode !== 'topup') {
    console.error(
      'usage: --dir <export folder> | --latest <book>, --mode evening|topup [--apply] [--allow-delete]',
    );
    return 64;
  }
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (values.apply && process.env.ALGOTEST_UPLOAD?.trim().toLowerCase() !== 'on') {
    console.log(
      'ALGOTEST_UPLOAD is not "on": nothing uploaded or deleted (dry run without --apply)',
    );
    return 0;
  }
  let exportDir = values.dir;
  if (!exportDir && values.latest) {
    const root = process.env.TRADING_DATA_ROOT?.trim();
    if (!root) {
      console.error('--latest needs TRADING_DATA_ROOT');
      return 1;
    }
    exportDir = (
      await readJson<{ dir: string }>(
        join(root, 'rotation', 'algotest', `latest-${values.latest}.json`),
      )
    ).dir;
  }
  if (!exportDir) {
    console.error('give --dir or --latest');
    return 64;
  }
  const mode = values.mode as Mode;
  const dir = resolve(exportDir);
  const ledgerPath = values.ledger ? resolve(values.ledger) : join(dir, '..', '..', 'ledger.jsonl');
  const manifest = await readJson<Manifest>(join(dir, 'manifest.json'));
  const today = istToday();
  const fits =
    mode === 'evening'
      ? manifest.source === 'preview' && manifest.day > today
      : manifest.source === 'recorded' && manifest.day === today;
  if (!fits) {
    console.error(
      `${mode}: the export is ${manifest.source} for ${manifest.day} (today ${today}); refusing`,
    );
    return 1;
  }
  const docs = new Map<string, unknown>();
  const wanted: Wanted[] = [];
  for (const s of manifest.strategies) {
    const file = join(dir, s.file);
    const text = await readFile(file, 'utf8');
    docs.set(s.name, JSON.parse(text));
    wanted.push({ name: s.name, variant: s.variant, file, sha: sha256(text) });
  }
  const ledger = existsSync(ledgerPath) ? parseLedger(await readFile(ledgerPath, 'utf8')) : [];

  const phone = process.env.ALGOTEST_PHONE?.trim();
  const password = process.env.ALGOTEST_PASSWORD?.trim();
  if (!phone || !password) {
    console.error('ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env');
    return 1;
  }
  registerSecret(password);
  const telegram = readTelegramConfig();
  const label = `AlgoTest ${manifest.book.toUpperCase()} ${mode === 'evening' ? 'evening' : '09:16 top-up'} for ${manifest.day}`;

  const browser = await chromium.launch({ headless: !values.headed });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const lines: string[] = [];
  let failed = false;

  try {
    await algotestLogin(page, { phone: normalizePhone(phone), password });
    const existing = await existingNames(page);
    const ownedPresent = [...existing].filter((n) => /^(T1|Core) · /.test(n));
    const deployed =
      mode === 'evening' ? await deployedNames(page, ownedPresent) : new Set<string>();
    const p = plan(mode, wanted, ledger, existing, deployed);
    lines.push(...summary(p, mode));
    console.log(`${label}${values.apply ? '' : ' (dry run)'}\n${lines.join('\n')}`);
    if (!values.apply) return 0;

    await mkdir(dirname(ledgerPath), { recursive: true });
    const record = async (
      action: 'upload' | 'delete',
      name: string,
      sha: string,
      ok: boolean,
      detail?: string,
    ) => {
      const row: LedgerRow = {
        at: new Date().toISOString(),
        day: manifest.day,
        book: manifest.book,
        mode,
        action,
        name,
        sha,
        ok,
        ...(detail ? { detail } : {}),
      };
      await appendFile(ledgerPath, `${JSON.stringify(row)}\n`, 'utf8');
    };

    for (const name of p.delete) {
      if (!values['allow-delete']) {
        lines.push(`skipped delete (no --allow-delete): ${name}`);
        continue;
      }
      try {
        await deleteOne(page, name);
        await record('delete', name, '', true);
        lines.push(`deleted ${name}`);
      } catch (error) {
        failed = true;
        await record('delete', name, '', false, describe(error));
        await safeScreenshot(page, 'delete-failed');
        await dumpHtml(page, 'delete-failed');
        lines.push(`❌ delete failed: ${name} — ${describe(error)}`);
      }
    }
    for (const w of p.upload) {
      try {
        const verdict = await uploadOne(page, w, docs.get(w.name));
        const ok = verdict.endsWith('identical');
        await record('upload', w.name, w.sha, true, verdict);
        if (!ok) failed = true;
        lines.push(`${ok ? '✅' : '❌'} uploaded ${w.name} (${verdict})`);
      } catch (error) {
        failed = true;
        await record('upload', w.name, w.sha, false, describe(error));
        await safeScreenshot(page, 'upload-failed');
        await dumpHtml(page, 'upload-failed');
        lines.push(`❌ upload failed: ${w.name} — ${describe(error)}`);
      }
    }
    if (needsAttention(p)) failed = true;
  } catch (error) {
    failed = true;
    lines.push(`❌ ${describe(error)}`);
    await safeScreenshot(page, 'strategy-upload-fatal');
  } finally {
    await browser.close().catch(() => undefined);
  }

  if (values.apply) {
    const head = failed ? `⚠️ ${label}: check AlgoTest` : `✅ ${label}`;
    await sendText(telegram, redact([head, ...lines].join('\n')), 'broker.algotest').catch(
      () => undefined,
    );
  }
  console.log(lines.join('\n'));
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code));
