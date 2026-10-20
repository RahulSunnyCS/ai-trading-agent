import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sendText } from '@trading/notify';
import { type Page, type Response, chromium } from 'playwright';
import { BASE_URL } from './algotest.js';
import { describeSource, readAutomation, uploadBooks } from './automation-settings.js';
import { normalizePhone, readTelegramConfig } from './config.js';
import { parseCards, parseLive, stillDeployed } from './deploy-plan.js';
import { describe, dumpHtml, safeScreenshot } from './diagnose.js';
import { algotestLoginLocked } from './login-lock.js';
import { sessionOver } from './quantiply-plan.js';
import { redact, registerSecret } from './secrets.js';
import { livePage, strategyPage } from './selectors.js';
import { csrfToken, deleteStrategyById, listViaApi } from './strategy-delete.js';
import {
  type LedgerRow,
  type Manifest,
  type Mode,
  type Wanted,
  afterDelete,
  comparable,
  idsByName,
  istToday,
  namesIn,
  needsAttention,
  newIdFor,
  owned,
  ownedIds,
  parseLedger,
  plan,
  savedId,
  sha256,
  summary,
} from './strategy-plan.js';
import { visibleWithin } from './wait.js';

/**
 * BL-137 Phase 3: put the day's rotation picks into AlgoTest as saved strategies, through the
 * website (AlgoTest support OK'd automating one's own account, 2026-10-19). Never deploys.
 *
 *   tsx src/strategy-upload.ts --dir <export folder> --mode evening|topup [--apply] [--allow-delete]
 *
 * `--dir` is a folder written by `obt rotation algotest-export` (manifest.json + one .algtst per
 * pick). Without `--apply` it logs in, reads what AlgoTest has and prints the plan, changing
 * nothing. Deleting also needs `--allow-delete` (the evening job passes it; see deleteOne).
 * `--apply` needs `ALGOTEST_UPLOAD=on`. The ledger (`--ledger`, default
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

interface Listing {
  names: Set<string>;
  /** `_id`s per exact name */
  ids: Map<string, string[]>;
}

/**
 * AlgoTest's saved strategies, `GET /strategies` through the API with the session (the same call
 * the builder page makes). Every listing in a run, before and after a delete, comes from here.
 */
async function listStrategies(page: Page): Promise<Listing> {
  const json = await listViaApi(page.request, await csrfToken(page.context()));
  return { names: namesIn(json), ids: idsByName(json) };
}

/**
 * Names AlgoTest shows as still deployed on /live: "n Deployed" above zero AND a card that could be
 * it is not squared off (the count may include finished instances), or an execution day ticked (it
 * would run again on that weekday). Unreadable counts as deployed. None of them is ever deleted.
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
  for (const name of candidates) {
    const repeats = live.rows.find((r) => r.name === name)?.days.some((d) => d !== '-') ?? false;
    if (repeats || stillDeployed(name, live, cards)) out.add(name);
  }
  return out;
}

async function freshBuilder(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/backtest`, { waitUntil: 'domcontentloaded' });
  const importButton = strategyPage.importButton(page);
  if (!(await visibleWithin(importButton, 10_000))) {
    await strategyPage.newStrategy(page).click();
    await importButton.waitFor({ timeout: 15_000 });
  }
}

/**
 * Import, save under `w.name`, then export it back and compare. Returns the read-back verdict and
 * the saved strategy's `_id` when the save answer carries one.
 */
async function uploadOne(
  page: Page,
  w: Wanted,
  sent: unknown,
): Promise<{ verdict: string; id?: string }> {
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
  const id = savedId(await response.json().catch(() => null));
  await strategyPage.savedToast(page).waitFor({ timeout: 10_000 });

  const download = page.waitForEvent('download', { timeout: 20_000 });
  await strategyPage.exportButton(page).click();
  const path = await (await download).path();
  const back = JSON.parse(await readFile(path, 'utf8'));
  return {
    verdict: comparable(back) === comparable(sent) ? READ_BACK_OK : 'READ-BACK DIFFERS',
    id,
  };
}

const READ_BACK_OK = 'read back: identical';

/** Another strategy vanished with a delete: stop everything (no retry), the owner must look. */
class Unsafe extends Error {}
/** A delete a retry cannot fix (no recorded id, a repeated or unknown name): the owner must look. */
class NeedsOwner extends Error {}

/**
 * Delete `name` through AlgoTest's API by the `_id` the tool recorded when it uploaded it, and only
 * if that id is the one strategy AlgoTest lists under that name (never by clicking a row, and never
 * a same-named strategy the owner saved).
 */
async function deleteOne(
  page: Page,
  name: string,
  id: string | undefined,
  listing: Listing,
  csrf: string,
): Promise<void> {
  if (!id) throw new NeedsOwner('no id was recorded when it was uploaded: delete it by hand once');
  const found = listing.ids.get(name) ?? [];
  if (found.length !== 1 || found[0] !== id)
    throw new NeedsOwner(
      `AlgoTest lists ${found.length} under this name and the recorded id ${id} ` +
        `${found.includes(id) ? 'is one of them' : 'is not among them'}; deleted none`,
    );
  await deleteStrategyById(page.request, id, csrf);
}

/**
 * One-time (2026-10-20): uploads before ids were recorded have none, so they could never be
 * deleted. For each such name the ledger owns, if AlgoTest lists exactly one strategy under it,
 * append an upload row with that `_id` (same sha). Writes only the local ledger; changes nothing on
 * AlgoTest. A name listed twice or not at all is left for the owner.
 */
async function recordIds(ledgerArg: string | undefined): Promise<number> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const dataRoot = process.env.TRADING_DATA_ROOT?.trim();
  const ledgerPath = ledgerArg
    ? resolve(ledgerArg)
    : join(dataRoot ?? '', 'rotation', 'algotest', 'ledger.jsonl');
  if (!ledgerArg && !dataRoot) {
    console.error('the ledger lives under TRADING_DATA_ROOT: set it, or pass --ledger');
    return 1;
  }
  const ledger = existsSync(ledgerPath) ? parseLedger(await readFile(ledgerPath, 'utf8')) : [];
  const known = ownedIds(ledger);
  const missing = [...owned(ledger).keys()].filter((name) => !known.has(name));
  if (!missing.length) {
    console.log('every strategy the tool owns already has its id recorded');
    return 0;
  }
  const phone = process.env.ALGOTEST_PHONE?.trim();
  const password = process.env.ALGOTEST_PASSWORD?.trim();
  if (!phone || !password) {
    console.error('ALGOTEST_PHONE and ALGOTEST_PASSWORD are needed');
    return 1;
  }
  registerSecret(password);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    page.setDefaultTimeout(20_000);
    await algotestLoginLocked(page, { phone: normalizePhone(phone), password }, 'strategy-upload');
    const listing = await listStrategies(page);
    for (const name of missing) {
      const found = listing.ids.get(name) ?? [];
      const last = [...ledger]
        .reverse()
        .find((r) => r.name === name && r.action === 'upload' && r.ok);
      if (found.length !== 1 || !last) {
        console.log(`left for the owner: ${name} (${found.length} listed under this name)`);
        continue;
      }
      const row: LedgerRow = {
        ...last,
        at: new Date().toISOString(),
        id: found[0],
        detail: 'id recorded from the listing (one-time, 2026-10-20)',
      };
      await appendFile(ledgerPath, `${JSON.stringify(row)}\n`, 'utf8');
      console.log(`recorded ${name} -> ${found[0]}`);
    }
    return 0;
  } finally {
    await browser.close().catch(() => undefined);
  }
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
      'record-ids': { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
  });
  if (values['record-ids']) return recordIds(values.ledger);
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
  /** a delete removed something else: no retry, the owner must look */
  let stopped = false;

  try {
    await algotestLoginLocked(page, { phone: normalizePhone(phone), password }, 'strategy-upload');
    let listing = await listStrategies(page);
    const existing = listing.names;
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
      id?: string,
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
        ...(id ? { id } : {}),
      };
      await appendFile(ledgerPath, `${JSON.stringify(row)}\n`, 'utf8');
    };

    // A changed strategy is deleted and uploaded again; if its delete does not happen, uploading
    // would leave two strategies with one name, so the upload is skipped too. The value says whether
    // a later attempt can sort it out ('retry') or only the owner can ('owner').
    const notDeleted = new Map<string, 'retry' | 'owner'>();
    const ids = ownedIds(ledger);
    const csrf = p.delete.length && values['allow-delete'] ? await csrfToken(page.context()) : '';
    // A STOP holds every later run's deletes until the owner has looked and removed this file.
    const stopFile = join(dirname(ledgerPath), 'STOP');
    const held = p.delete.length > 0 && values['allow-delete'] && existsSync(stopFile);
    if (held) {
      failed = true;
      lines.push(`deletes held since a STOP: check AlgoTest, then remove ${stopFile}`);
    }
    let deletesStopped = held;
    for (const name of p.delete) {
      if (!values['allow-delete'] || deletesStopped) {
        notDeleted.set(name, 'owner');
        lines.push(
          deletesStopped
            ? `not deleted (deletes stopped): ${name}`
            : `skipped delete (no --allow-delete): ${name}`,
        );
        continue;
      }
      const id = ids.get(name);
      try {
        await deleteOne(page, name, id, listing, csrf);
      } catch (error) {
        failed = true;
        const owner = error instanceof NeedsOwner;
        notDeleted.set(name, owner ? 'owner' : 'retry');
        if (!owner) retryable = true;
        await record('delete', name, '', false, describe(error), id);
        lines.push(`❌ delete failed: ${name} — ${describe(error)}`);
        continue;
      }
      // AlgoTest answered 2xx: no longer the tool's, whatever the check below finds
      await record('delete', name, '', true, undefined, id);
      lines.push(`deleted ${name}`);
      let after: Map<string, string[]>;
      try {
        after = idsByName(await listViaApi(page.request, csrf));
      } catch (error) {
        failed = true;
        retryable = true; // the next attempt lists afresh and finds it gone
        deletesStopped = true;
        notDeleted.set(name, 'retry'); // unchecked: never upload a second copy beside it
        lines.push(`❌ could not list AlgoTest after deleting ${name}: ${describe(error)}`);
        continue;
      }
      const check = afterDelete(listing.ids, after, id ?? '');
      if (check.vanished.length) {
        const why = `deleting ${name} (${id}) also removed ${check.vanished.join(', ')}`;
        await writeFile(stopFile, `${new Date().toISOString()} ${why}\n`, 'utf8').catch(
          () => undefined,
        );
        throw new Unsafe(`STOP: ${why}`);
      }
      if (check.stillListed) {
        failed = true;
        deletesStopped = true;
        notDeleted.set(name, 'owner'); // two copies under one name would follow: never
        lines.push(`❌ ${name} was answered as deleted but is still listed (${id})`);
        continue;
      }
      listing = { names: new Set(after.keys()), ids: after };
    }
    for (const w of p.upload) {
      const kept = notDeleted.get(w.name);
      if (kept) {
        failed = true;
        if (kept === 'retry') retryable = true;
        lines.push(`NOT re-uploaded, the old copy is still there: ${w.name}`);
        continue;
      }
      try {
        const before = listing.ids;
        let { verdict, id } = await uploadOne(page, w, docs.get(w.name));
        if (!id) {
          // the save answer had no id: the one new id under this name in a fresh listing
          listing = await listStrategies(page);
          id = newIdFor(before, listing.ids, w.name);
        }
        if (!id) {
          failed = true; // never deletable by the tool: the owner must know now, not when dropped
          lines.push(`⚠️ ${w.name}: saved, but its AlgoTest id could not be read`);
        }
        const ok = verdict === READ_BACK_OK;
        // Saved but not as sent: owned (so it can be replaced), under a sha no export will match.
        await record('upload', w.name, ok ? w.sha : `mismatch:${w.sha}`, true, verdict, id);
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
    if (error instanceof Unsafe) stopped = true;
    else retryable = true;
    lines.push(`❌ ${describe(error)}`);
    await safeScreenshot(page, 'strategy-upload-fatal');
  } finally {
    await browser.close().catch(() => undefined);
  }

  if (values.apply) {
    const head = stopped
      ? `🛑 ${label}: STOPPED, a delete removed something else. Check AlgoTest now; deletes are held until the STOP file is removed`
      : failed
        ? `⚠️ ${label}: check AlgoTest`
        : `✅ ${label}`;
    await sendText(telegram, redact([head, ...lines].join('\n')), 'broker.algotest').catch(
      () => undefined,
    );
  }
  console.log(lines.join('\n'));
  // 1: the scheduler retries; 3 (noRetryExitCodes): a conflict, a deployed strategy kept, a
  // read-back that differs, a delete only the owner can sort out - a retry would only repeat it.
  // A STOP is always 3: a retry would list afresh and could not see what vanished.
  if (stopped) return 3;
  if (retryable) return 1;
  return failed ? 3 : 0;
}

main().then((code) => process.exit(code));
