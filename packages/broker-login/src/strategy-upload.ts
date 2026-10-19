import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sendText } from '@trading/notify';
import { type Page, type Response, chromium } from 'playwright';
import { BASE_URL, algotestLogin } from './algotest.js';
import { describeSource, readAutomation, uploadBooks } from './automation-settings.js';
import { normalizePhone, readTelegramConfig } from './config.js';
import { parseCards, parseLive, stillDeployed } from './deploy-plan.js';
import { describe, dumpHtml, safeScreenshot } from './diagnose.js';
import { sessionOver } from './quantiply-plan.js';
import { redact, registerSecret } from './secrets.js';
import { livePage, strategyPage } from './selectors.js';
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
 * supervised run. `--apply` needs `ALGOTEST_UPLOAD=on`. The ledger (`--ledger`, default
 * TRADING_DATA_ROOT/rotation/algotest/ledger.jsonl) records every upload and delete; only
 * strategies in it are ever deleted. Locators: `strategyPage` / `livePage` in selectors.ts.
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

/**
 * Names AlgoTest shows as still deployed on /live: "n Deployed" above zero AND a card that could be
 * it is not squared off (the count may include finished instances). Unreadable counts as deployed.
 */
async function deployedNames(page: Page, candidates: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!candidates.length) return out;
  await page.goto(`${BASE_URL}/live`, { waitUntil: 'domcontentloaded' });
  await livePage
    .anyRowCount(page)
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  const text = await page.evaluate(() => document.body.innerText);
  const live = parseLive(text);
  const cards = parseCards(text);
  for (const name of candidates) if (stillDeployed(name, live, cards)) out.add(name);
  return out;
}

async function freshBuilder(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/backtest`, { waitUntil: 'domcontentloaded' });
  const importButton = strategyPage.importButton(page);
  if (!(await importButton.isVisible({ timeout: 10_000 }).catch(() => false))) {
    await strategyPage.newStrategy(page).click();
    await importButton.waitFor({ timeout: 15_000 });
  }
}

/** Import, save under `w.name`, then export it back and compare. Returns the read-back verdict. */
async function uploadOne(page: Page, w: Wanted, sent: unknown): Promise<string> {
  await freshBuilder(page);
  await strategyPage.importInput(page).setInputFiles(w.file);
  await strategyPage.title(page, w.name).waitFor({ timeout: 15_000 });

  await strategyPage.saveButton(page).click();
  await strategyPage.saveDialog(page).waitFor({ timeout: 10_000 });
  await strategyPage.saveName(page).fill(w.name);
  const saved = page.waitForResponse(
    (r: Response) =>
      /api\.algotest\.in\/strategy(\?|$)/.test(r.url()) && r.request().method() !== 'GET',
    { timeout: 20_000 },
  );
  await strategyPage.saveDone(page).click();
  const response = await saved;
  if (!response.ok()) throw new Error(`save answered ${response.status()}`);
  await strategyPage.savedToast(page).waitFor({ timeout: 10_000 });

  const download = page.waitForEvent('download', { timeout: 20_000 });
  await strategyPage.exportButton(page).click();
  const path = await (await download).path();
  const back = JSON.parse(await readFile(path, 'utf8'));
  return comparable(back) === comparable(sent) ? READ_BACK_OK : 'READ-BACK DIFFERS';
}

const READ_BACK_OK = 'read back: identical';

/** PROVISIONAL (the delete dialog has not been seen): behind --allow-delete. */
async function deleteOne(page: Page, name: string): Promise<void> {
  await page.goto(`${BASE_URL}/backtest`, { waitUntil: 'domcontentloaded' });
  await strategyPage.search(page).fill(name);
  await strategyPage.rowMenu(page, name).click();
  const item = strategyPage.rowMenuDelete(page);
  await item.waitFor({ timeout: 5_000 }); // the right menu opened: "Add to folder" beside "Delete"
  const deleted = page.waitForResponse(
    (r: Response) =>
      /api\.algotest\.in\/strateg/.test(r.url()) && r.request().method() === 'DELETE',
    { timeout: 20_000 },
  );
  await item.click();
  const confirm = strategyPage.deleteConfirm(page).last();
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
      'from-settings': { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      'allow-delete': { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
  });
  if (values.mode !== 'evening' && values.mode !== 'topup') {
    console.error(
      'usage: --from-settings | --latest <book> | --dir <export folder>, --mode evening|topup [--apply] [--allow-delete]',
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
  // Evening mode deletes today's strategies that tomorrow drops: before 15:30 IST one of them may
  // still be waiting to be deployed, so it never runs then (Apply now, a manual run, a catch-up).
  if (values.mode === 'evening' && !sessionOver()) {
    console.error("evening mode runs only after 15:30 IST: today's picks may still trade");
    return 1;
  }
  const dataRoot = process.env.TRADING_DATA_ROOT?.trim();
  // BL-140: --from-settings uploads every list the dashboard's Settings › Automation gives
  // AlgoTest (one account; its brokers matter only when deploying). None: hands off.
  let decidedBy = '';
  let books: string[] = values.latest ? [values.latest] : [];
  if (values['from-settings']) {
    const automation = readAutomation();
    decidedBy = describeSource(automation);
    books = uploadBooks(automation, 'algotest');
    if (!books.length) {
      console.log(`AlgoTest: nothing to upload (${decidedBy}); nothing changed`);
      return 0;
    }
  }
  const exportDirs: string[] = values.dir ? [values.dir] : [];
  if (!exportDirs.length && books.length) {
    if (!dataRoot) {
      console.error('--latest / --from-settings need TRADING_DATA_ROOT');
      return 1;
    }
    for (const book of books) {
      const pointer = join(dataRoot, 'rotation', 'algotest', `latest-${book}.json`);
      exportDirs.push((await readJson<{ dir: string }>(pointer)).dir);
    }
  }
  if (!exportDirs.length) {
    console.error('give --from-settings, --latest or --dir');
    return 64;
  }
  const mode = values.mode as Mode;
  if (!values.ledger && !dataRoot) {
    console.error('the ledger lives under TRADING_DATA_ROOT: set it, or pass --ledger');
    return 1;
  }
  const ledgerPath = values.ledger
    ? resolve(values.ledger)
    : join(dataRoot ?? '', 'rotation', 'algotest', 'ledger.jsonl');
  const today = istToday();
  const docs = new Map<string, unknown>();
  const bookOf = new Map<string, string>();
  const wanted: Wanted[] = [];
  const manifests: Manifest[] = [];
  /** lists whose export is not today's yet (a late T1 day): skipped, and the job retries */
  const notReady: string[] = [];
  for (const exportDir of exportDirs) {
    const dir = resolve(exportDir);
    const m = await readJson<Manifest>(join(dir, 'manifest.json'));
    const fits =
      mode === 'evening'
        ? m.source === 'preview' && m.day > today
        : m.source === 'recorded' && m.day === today;
    if (!fits) {
      // With several lists from the settings, one not ready yet must not hold the others back.
      if (values['from-settings'] && exportDirs.length > 1) {
        notReady.push(m.book);
        console.error(`${mode}: the ${m.book} export is ${m.source} for ${m.day}; skipped for now`);
        continue;
      }
      console.error(
        `${mode}: the ${m.book} export is ${m.source} for ${m.day} (today ${today}); refusing`,
      );
      return 1;
    }
    if (manifests.length && manifests[0]?.day !== m.day) {
      console.error(
        `the exports are for different days (${manifests[0]?.day}, ${m.day}); refusing`,
      );
      return 1;
    }
    manifests.push(m);
    for (const s of m.strategies) {
      const file = join(dir, s.file);
      const text = await readFile(file, 'utf8');
      docs.set(s.name, JSON.parse(text));
      bookOf.set(s.name, m.book);
      wanted.push({ name: s.name, variant: s.variant, file, sha: sha256(text) });
    }
  }
  if (!manifests.length) {
    console.error(`${mode}: no list is ready (${notReady.join(', ')}); the job retries`);
    return 1;
  }
  // Several lists upload as one plan: names never collide (`Core · ` / `T1 · `).
  const manifest = {
    day: manifests[0]?.day ?? today,
    book: manifests.map((m) => m.book).join('+'),
  };
  const ledger = existsSync(ledgerPath) ? parseLedger(await readFile(ledgerPath, 'utf8')) : [];

  const phone = process.env.ALGOTEST_PHONE?.trim();
  const password = process.env.ALGOTEST_PASSWORD?.trim();
  if (!phone || !password) {
    console.error('ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env');
    return 1;
  }
  registerSecret(password);
  const telegram = readTelegramConfig();
  const label = `AlgoTest ${manifest.book.toUpperCase()} ${mode === 'evening' ? 'evening' : '09:16 top-up'} for ${manifest.day}${decidedBy ? `, ${decidedBy}` : ''}`;

  const browser = await chromium.launch({ headless: !values.headed });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const lines: string[] = notReady.length
    ? [`not ready yet, retried later: ${notReady.join(', ')}`]
    : [];
  let failed = false;
  /** a failure a later attempt may fix; anything else that failed needs the owner (exit 3) */
  let retryable = notReady.length > 0;

  try {
    await algotestLogin(page, { phone: normalizePhone(phone), password });
    const existing = await existingNames(page);
    const ownedPresent = [...existing].filter((n) => /^(T1|Core) · /.test(n));
    const deployed =
      mode === 'evening' ? await deployedNames(page, ownedPresent) : new Set<string>();
    const p = plan(mode, wanted, ledger, existing, deployed);
    // A list whose export is not ready keeps its strategies until it is (no delete without a
    // replacement on the way).
    const PREFIX: Record<string, string> = { core: 'Core · ', t1: 'T1 · ' };
    if (notReady.length) {
      p.delete = p.delete.filter((n) => !notReady.some((b) => n.startsWith(PREFIX[b] ?? '\0')));
    }
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
        book: bookOf.get(name) ?? manifest.book,
        mode,
        action,
        name,
        sha,
        ok,
        ...(detail ? { detail } : {}),
      };
      await appendFile(ledgerPath, `${JSON.stringify(row)}\n`, 'utf8');
    };

    // A changed strategy is deleted and uploaded again; if its delete does not happen, uploading
    // would leave two strategies with one name, so the upload is skipped too.
    const notDeleted = new Set<string>();
    for (const name of p.delete) {
      if (!values['allow-delete']) {
        notDeleted.add(name);
        lines.push(`skipped delete (no --allow-delete): ${name}`);
        continue;
      }
      try {
        await deleteOne(page, name);
        await record('delete', name, '', true);
        lines.push(`deleted ${name}`);
      } catch (error) {
        failed = true;
        retryable = true;
        notDeleted.add(name);
        await record('delete', name, '', false, describe(error));
        await safeScreenshot(page, 'delete-failed');
        await dumpHtml(page, 'delete-failed');
        lines.push(`❌ delete failed: ${name} — ${describe(error)}`);
      }
    }
    for (const w of p.upload) {
      if (notDeleted.has(w.name)) {
        failed = true;
        retryable = true;
        lines.push(`NOT re-uploaded, the old copy is still there: ${w.name}`);
        continue;
      }
      try {
        const verdict = await uploadOne(page, w, docs.get(w.name));
        const ok = verdict === READ_BACK_OK;
        // Saved but not as sent: owned (so it can be replaced), under a sha no export will match.
        await record('upload', w.name, ok ? w.sha : `mismatch:${w.sha}`, true, verdict);
        if (!ok) failed = true; // a read-back that differs needs the owner, not a retry
        lines.push(`${ok ? '✅' : '❌'} uploaded ${w.name} (${verdict})`);
      } catch (error) {
        failed = true;
        retryable = true;
        await record('upload', w.name, w.sha, false, describe(error));
        await safeScreenshot(page, 'upload-failed');
        await dumpHtml(page, 'upload-failed');
        lines.push(`❌ upload failed: ${w.name} — ${describe(error)}`);
      }
    }
    if (needsAttention(p)) failed = true;
  } catch (error) {
    failed = true;
    retryable = true;
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
  // 1: the scheduler retries; 3 (noRetryExitCodes): a conflict, a deployed strategy kept, a
  // read-back that differs - a retry would only repeat it.
  if (retryable) return 1;
  return failed ? 3 : 0;
}

main().then((code) => process.exit(code));
