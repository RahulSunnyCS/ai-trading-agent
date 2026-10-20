import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { APIRequestContext } from 'playwright';
import { chromium } from 'playwright';
import { algotestLogin } from './algotest.js';
import {
  type Broker,
  type Platform,
  describeSource,
  effectiveRow,
  readAutomation,
} from './automation-settings.js';
import { normalizePhone } from './config.js';
import { describe } from './diagnose.js';
import {
  type LiveBroker,
  type LiveLine,
  type SectionLine,
  type StrategyLine,
  algotestLines,
  algotestMultiplier,
  algotestOwnership,
  mergeCapture,
  parseLiveFile,
  quantiplyLastValues,
  quantiplyLines,
  quantiplyOwned,
  quantiplySummaries,
  quantiplyTotal,
  renderLiveFile,
  summarizeCapture,
} from './live-capture-plan.js';
import { parseQLedger, sessionOver, weekdayOf } from './quantiply-plan.js';
import {
  LoginHeld,
  LoginRefused,
  checkLoginHold,
  openQuantiply,
  quantiplyCredentials,
  quantiplyLedgerPath,
} from './quantiply-session.js';
import { registerSecret } from './secrets.js';
import { ALGOTEST_API, csrfToken } from './strategy-delete.js';
import { istToday, parseLedger } from './strategy-plan.js';

/**
 * BL-141 Phase 2: read every strategy that ran today on each platform + broker the automation
 * settings (BL-140) have on, the tool's and the owner's own, and record them in
 * `TRADING_DATA_ROOT/rotation/live/<day>.jsonl` (`live-capture-plan.ts` has the file's shape).
 *
 *   tsx src/live-capture.ts [--day YYYY-MM-DD] [--only algotest|quantiply] [--dry-run] [--out FILE]
 *
 * Read-only on both platforms: GET calls only (`docs/algotest-execution.md`, "Live results"), the
 * same logins as the uploaders (AlgoTest's site login; Quantiply through `quantiply-session.ts`,
 * which waits out the account's last TOTP window). Before 15:30 IST on the day itself it only
 * prints (positions may still be open). `--out` writes the merged file there instead (a check by
 * hand that must not touch the day's file). Exit 0 every section read, 1 something failed (the job
 * retries), 3 a Quantiply login is held or was refused (not retried).
 */

const EXIT_RETRY = 1;
const EXIT_NO_RETRY = 3;
const VIEWPORT = { width: 1440, height: 900 };

interface Section {
  section: SectionLine;
  strategies: StrategyLine[];
}

function section(
  day: string,
  platform: Platform,
  broker: LiveBroker | 'all',
  strategies: StrategyLine[],
  error: string | null,
): Section {
  return {
    section: {
      kind: 'section',
      day,
      platform,
      broker,
      ok: error === null,
      error,
      strategies: strategies.length,
      captured_at: new Date().toISOString(),
    },
    strategies,
  };
}

async function getJson(request: APIRequestContext, url: string, csrf: string): Promise<unknown> {
  const response = await request.get(url, {
    headers: { 'X-CSRF-TOKEN-ACCESS': csrf },
    failOnStatusCode: false,
    timeout: 20_000,
  });
  if (!response.ok()) throw new Error(`GET ${new URL(url).pathname} answered ${response.status()}`);
  return response.json();
}

/** AlgoTest: one site login, then the live and exited executions and each one's multiplier. */
async function captureAlgotest(day: string, today: string, ledgerPath: string): Promise<Section> {
  const phone = process.env.ALGOTEST_PHONE?.trim();
  const password = process.env.ALGOTEST_PASSWORD?.trim();
  if (!phone || !password) {
    return section(
      day,
      'algotest',
      'all',
      [],
      'ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env',
    );
  }
  registerSecret(password);
  const ledger = existsSync(ledgerPath) ? parseLedger(await readFile(ledgerPath, 'utf8')) : [];
  const own = algotestOwnership(ledger);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await algotestLogin(page, { phone: normalizePhone(phone), password });
    const csrf = await csrfToken(context);
    const lists: unknown[] = [];
    const notes: string[] = [];
    // Today's deploys are on the live list (the /live cards) until the day is over; earlier days
    // only on the exited list (past trades), which takes a minute range in IST.
    if (day === today) {
      lists.push(
        await getJson(
          context.request,
          `${ALGOTEST_API}/execution/v2/executions?environment=live&is_signal=false`,
          csrf,
        ),
      );
    }
    const range = new URLSearchParams({
      start_date: `${day}T00:00`,
      end_date: `${day}T23:59`,
      environment: 'live',
      is_signal: 'false',
    });
    try {
      lists.push(
        await getJson(
          context.request,
          `${ALGOTEST_API}/execution/v2/exited-executions?${range}`,
          csrf,
        ),
      );
    } catch (error) {
      if (day !== today) throw error;
      notes.push(`exited list: ${describe(error)}`); // the live list has today's
    }
    const first = algotestLines(day, lists, own);
    const multipliers = new Map<string, number>();
    for (const line of first) {
      try {
        const info = await getJson(
          context.request,
          `${ALGOTEST_API}/execution/v2/execution-info/${encodeURIComponent(line.platform_id)}`,
          csrf,
        );
        const m = algotestMultiplier(info);
        if (m !== null) multipliers.set(line.platform_id, m);
      } catch (error) {
        notes.push(`${line.name}: multiplier not read (${describe(error)})`);
      }
    }
    for (const n of notes) console.log(`  AlgoTest: ${n}`);
    return section(day, 'algotest', 'all', algotestLines(day, lists, own, multipliers), null);
  } catch (error) {
    return section(day, 'algotest', 'all', [], describe(error));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Quantiply, one account: the account P&L chart for the day, named from the day-wise list. */
async function captureQuantiply(
  day: string,
  today: string,
  broker: Broker,
  dataRoot: string,
): Promise<Section & { noRetry?: boolean }> {
  const ledgerPath = quantiplyLedgerPath(dataRoot, broker);
  const stateDir = dirname(ledgerPath);
  try {
    const creds = quantiplyCredentials(broker);
    await checkLoginHold(creds, stateDir);
    const ledger = existsSync(ledgerPath) ? parseQLedger(await readFile(ledgerPath, 'utf8')) : [];
    const api = await openQuantiply(creds, stateDir, { retryTotpOnce: true });
    const summaries = quantiplySummaries(await api.dayWise());
    const pages = await api.pnlChartAccount(day);
    const last = quantiplyLastValues(pages);
    // Fills: only today, while Quantiply still has the day's state on each algo.
    const positions = new Map<string, unknown>();
    if (day === today) {
      const weekday = weekdayOf(day);
      for (const id of last.keys()) {
        if (!summaries.some((s) => s.id === id && s.day === weekday)) continue;
        try {
          positions.set(id, await api.get(id));
        } catch (error) {
          console.log(`  Quantiply · ${broker}: fills of one algo not read (${describe(error)})`);
        }
      }
    }
    const lines = quantiplyLines(day, broker, summaries, last, quantiplyOwned(ledger), positions);
    const total = quantiplyTotal(pages);
    const sum = lines.reduce((s, l) => s + (l.pnl ?? 0), 0);
    if (total !== null && Math.abs(total - sum) > 1) {
      console.log(
        `  Quantiply · ${broker}: the algos add up to ${sum.toFixed(2)}, the chart says ${total}`,
      );
    }
    return section(day, 'quantiply', broker, lines, null);
  } catch (error) {
    const noRetry = error instanceof LoginHeld || error instanceof LoginRefused;
    return { ...section(day, 'quantiply', broker, [], describe(error)), noRetry };
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      day: { type: 'string' },
      only: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  if (existsSync('.env')) process.loadEnvFile('.env');
  const today = istToday();
  const day = values.day ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today) {
    console.error(`--day ${day}: give a day up to today (YYYY-MM-DD)`);
    return 64;
  }
  const only = values.only;
  if (only && only !== 'algotest' && only !== 'quantiply') {
    console.error('--only algotest | quantiply');
    return 64;
  }
  // Before 15:30 IST a position may still be open: print only, so a stray run never stands in
  // for the 15:40 capture.
  const dryRun = values['dry-run'] || (day === today && !sessionOver());
  if (dryRun && !values['dry-run']) console.log('before 15:30 IST: printing only, nothing written');
  const dataRoot = process.env.TRADING_DATA_ROOT?.trim();
  if (!dataRoot) {
    console.error('TRADING_DATA_ROOT is not set');
    return EXIT_RETRY;
  }
  const automation = readAutomation();
  const wanted = (platform: Platform) =>
    (['finvasia', 'angelone'] as const).filter((b) => {
      const row = effectiveRow(automation, platform, b);
      return row.login || row.upload;
    });
  console.log(`live capture for ${day} (${describeSource(automation)})`);

  const sections: (Section & { noRetry?: boolean })[] = [];
  if (only !== 'quantiply' && wanted('algotest').length) {
    sections.push(
      await captureAlgotest(day, today, join(dataRoot, 'rotation', 'algotest', 'ledger.jsonl')),
    );
  }
  if (only !== 'algotest') {
    for (const broker of wanted('quantiply')) {
      sections.push(await captureQuantiply(day, today, broker, dataRoot));
    }
  }
  if (!sections.length) {
    console.log('no platform row is on in the automation settings: nothing to read');
    return 0;
  }

  const dayFile = join(dataRoot, 'rotation', 'live', `${day}.jsonl`);
  const path = values.out ?? dayFile;
  const previous: LiveLine[] = existsSync(path) ? parseLiveFile(await readFile(path, 'utf8')) : [];
  const merged = mergeCapture(previous, sections);
  for (const line of summarizeCapture(merged)) console.log(`  ${line}`);
  for (const s of sections) {
    for (const l of s.strategies) {
      const pnl = l.pnl === null ? '?' : l.pnl.toFixed(2);
      const entry = l.fills?.[0]?.entry?.at.slice(11, 16);
      const legs = l.fills ? ` · ${l.fills.length} fills${entry ? ` from ${entry}` : ''}` : '';
      console.log(
        `    ${l.platform}/${l.broker} ${l.source.padEnd(13)} ${l.name}  x${l.multiplier ?? '?'}  ${pnl}${legs}${l.open_legs ? ` · ${l.open_legs} OPEN` : ''}`,
      );
    }
  }
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, renderLiveFile(merged), 'utf8');
    await rename(tmp, path);
    console.log(`written ${path}`);
  }
  const failed = sections.filter((s) => !s.section.ok);
  if (!failed.length) return 0;
  for (const s of failed)
    console.error(`${s.section.platform}/${s.section.broker}: ${s.section.error}`);
  return failed.every((s) => s.noRetry) ? EXIT_NO_RETRY : EXIT_RETRY;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(describe(error));
    process.exit(EXIT_RETRY);
  },
);
