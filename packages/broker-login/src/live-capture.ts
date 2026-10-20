import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { isTradingDay } from '@trading/market-reference';
import type { APIRequestContext } from 'playwright';
import { chromium } from 'playwright';
import { algotestLogin } from './algotest.js';
import {
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
  backfillDays,
  exitCodeFor,
  mergeCapture,
  parseLiveFile,
  quantiplyLines,
  quantiplyMismatch,
  quantiplyOwned,
  quantiplyRuns,
  quantiplySummaries,
  quantiplyTotal,
  renderLiveFile,
  sectionKey,
  sectionsToRead,
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
 * BL-141 Phase 2: record every strategy that ran on each platform + broker the automation
 * settings (BL-140) have on, the tool's and the owner's own, in
 * `TRADING_DATA_ROOT/rotation/live/<day>.jsonl` (`live-capture-plan.ts` has the file's shape).
 *
 *   tsx src/live-capture.ts [--day YYYY-MM-DD] [--only algotest|quantiply] [--force]
 *                           [--no-backfill] [--soft-fail] [--dry-run] [--out FILE]
 *
 * - Read-only on both platforms: GET calls only (`docs/algotest-execution.md`, "Live results"),
 *   the uploaders' logins (AlgoTest's site login; Quantiply through `quantiply-session.ts`, which
 *   waits out the account's last TOTP window). One login per platform per run, for every day read.
 * - A run reads only the sections a day's file does not have as read (`--force`: all again), so a
 *   retry never logs in again to an account already read.
 * - Without `--day` it reads today (after 15:30 IST; before that today is skipped, positions may
 *   still be open) and back-fills the last 5 trading days that miss a section (both platforms keep
 *   a day's results after its strategies are deleted). `--day D` reads that day only.
 * - Exit 0 everything read; 1 a retry may help; 3 a retry cannot (missing credentials, a held or
 *   refused Quantiply login). `--soft-fail` exits 0 anyway (the 15:40 attempt; its retry job
 *   alerts).
 */

const VIEWPORT = { width: 1440, height: 900 };

interface Section {
  section: SectionLine;
  strategies: StrategyLine[];
}

const sectionLine = (
  day: string,
  platform: Platform,
  broker: LiveBroker | 'all',
  strategies: StrategyLine[],
  error: string | null,
  kind: 'retry' | 'config' | null = error ? 'retry' : null,
): Section => ({
  section: {
    kind: 'section',
    day,
    platform,
    broker,
    ok: error === null,
    error,
    error_kind: error ? kind : null,
    strategies: strategies.length,
    captured_at: new Date().toISOString(),
  },
  strategies,
});

async function getJson(request: APIRequestContext, url: string, csrf: string): Promise<unknown> {
  const response = await request.get(url, {
    headers: { 'X-CSRF-TOKEN-ACCESS': csrf },
    failOnStatusCode: false,
    timeout: 20_000,
  });
  if (!response.ok()) throw new Error(`GET ${new URL(url).pathname} answered ${response.status()}`);
  return response.json();
}

/** AlgoTest: one site login, then for each day the exited (and, today, live) executions. */
async function captureAlgotest(
  days: string[],
  today: string,
  ledgerPath: string,
): Promise<Section[]> {
  const phone = process.env.ALGOTEST_PHONE?.trim();
  const password = process.env.ALGOTEST_PASSWORD?.trim();
  if (!phone || !password) {
    const why = 'ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env';
    return days.map((d) => sectionLine(d, 'algotest', 'all', [], why, 'config'));
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
    try {
      await algotestLogin(page, { phone: normalizePhone(phone), password });
    } catch (error) {
      return days.map((d) => sectionLine(d, 'algotest', 'all', [], describe(error)));
    }
    const csrf = await csrfToken(context);
    const out: Section[] = [];
    for (const day of days) {
      try {
        const lists: unknown[] = [];
        // Today's deploys are on the live list (the /live cards) until the day is over; the
        // exited list (past trades, a minute range in IST) has the rest. Both must be read.
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
        lists.push(
          await getJson(
            context.request,
            `${ALGOTEST_API}/execution/v2/exited-executions?${range}`,
            csrf,
          ),
        );
        const multipliers = new Map<string, number>();
        for (const line of algotestLines(day, lists, own)) {
          const info = await getJson(
            context.request,
            `${ALGOTEST_API}/execution/v2/execution-info/${encodeURIComponent(line.platform_id)}`,
            csrf,
          );
          const m = algotestMultiplier(info);
          if (m !== null) multipliers.set(line.platform_id, m);
        }
        out.push(
          sectionLine(day, 'algotest', 'all', algotestLines(day, lists, own, multipliers), null),
        );
      } catch (error) {
        out.push(sectionLine(day, 'algotest', 'all', [], describe(error)));
      }
    }
    return out;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Quantiply, one account, one login: the account P&L chart for each day, named from the list. */
async function captureQuantiply(
  days: string[],
  today: string,
  broker: LiveBroker,
  dataRoot: string,
): Promise<Section[]> {
  const ledgerPath = quantiplyLedgerPath(dataRoot, broker);
  const stateDir = dirname(ledgerPath);
  const fail = (error: unknown, kind: 'retry' | 'config') =>
    days.map((d) => sectionLine(d, 'quantiply', broker, [], describe(error), kind));
  let api: Awaited<ReturnType<typeof openQuantiply>>;
  let owned: Map<string, string>;
  try {
    const creds = quantiplyCredentials(broker);
    await checkLoginHold(creds, stateDir);
    owned = quantiplyOwned(
      existsSync(ledgerPath) ? parseQLedger(await readFile(ledgerPath, 'utf8')) : [],
    );
    api = await openQuantiply(creds, stateDir);
  } catch (error) {
    const config =
      error instanceof LoginHeld ||
      error instanceof LoginRefused ||
      /missing from \.env/.test(describe(error));
    return fail(error, config ? 'config' : 'retry');
  }
  let summaries: ReturnType<typeof quantiplySummaries>;
  try {
    summaries = quantiplySummaries(await api.dayWise());
  } catch (error) {
    return fail(error, 'retry');
  }
  const out: Section[] = [];
  for (const day of days) {
    try {
      const pages = await api.pnlChartAccount(day);
      const runs = quantiplyRuns(pages);
      const mismatch = quantiplyMismatch(runs, quantiplyTotal(pages));
      if (mismatch) throw new Error(mismatch);
      // Fills and "did not trade": only today, while Quantiply still has the day's state.
      const positions = new Map<string, unknown>();
      const weekday = day === today ? weekdayOf(day) : undefined;
      if (weekday) {
        for (const id of runs.keys()) {
          if (!summaries.some((s) => s.id === id && s.day === weekday)) continue;
          try {
            positions.set(id, await api.get(id));
          } catch (error) {
            console.log(`  Quantiply · ${broker}: fills of one algo not read (${describe(error)})`);
          }
        }
      }
      const lines = quantiplyLines(day, broker, summaries, runs, owned, positions, weekday);
      out.push(sectionLine(day, 'quantiply', broker, lines, null));
    } catch (error) {
      out.push(sectionLine(day, 'quantiply', broker, [], describe(error)));
    }
  }
  return out;
}

const liveDir = (dataRoot: string) => join(dataRoot, 'rotation', 'live');

async function readDay(path: string): Promise<LiveLine[] | null> {
  return existsSync(path) ? parseLiveFile(await readFile(path, 'utf8')) : null;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      day: { type: 'string' },
      only: { type: 'string' },
      force: { type: 'boolean', default: false },
      'no-backfill': { type: 'boolean', default: false },
      'soft-fail': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  if (existsSync('.env')) process.loadEnvFile('.env');
  const today = istToday();
  const only = values.only;
  if (only && only !== 'algotest' && only !== 'quantiply') {
    console.error('--only algotest | quantiply');
    return 64;
  }
  if (values.day && (!/^\d{4}-\d{2}-\d{2}$/.test(values.day) || values.day > today)) {
    console.error(`--day ${values.day}: give a day up to today (YYYY-MM-DD)`);
    return 64;
  }
  if (values.out && !values.day) {
    console.error('--out needs --day (one day, one file)');
    return 64;
  }
  const dataRoot = process.env.TRADING_DATA_ROOT?.trim();
  if (!dataRoot) {
    console.error('TRADING_DATA_ROOT is not set');
    return values['soft-fail'] ? 0 : 1;
  }
  const automation = readAutomation();
  const on = (platform: Platform) =>
    (['finvasia', 'angelone'] as const).filter((b) => {
      const row = effectiveRow(automation, platform, b);
      return row.login || row.upload;
    });
  const wanted: string[] = [];
  if (only !== 'quantiply' && on('algotest').length) wanted.push(sectionKey('algotest', 'all'));
  if (only !== 'algotest') for (const b of on('quantiply')) wanted.push(sectionKey('quantiply', b));
  console.log(`live capture (${describeSource(automation)}): ${wanted.join(', ') || 'nothing on'}`);
  if (!wanted.length) return 0;

  const dayPath = (day: string) =>
    values.out && day === values.day ? values.out : join(liveDir(dataRoot), `${day}.jsonl`);
  // Which days: the one asked for, or today (once its session is over) plus the back-fill.
  let days: string[];
  let dryRun = values['dry-run'];
  if (values.day) {
    days = [values.day];
    if (values.day === today && !sessionOver() && !dryRun) {
      console.log('before 15:30 IST: printing only, nothing written');
      dryRun = true;
    }
  } else {
    const existing = existsSync(liveDir(dataRoot))
      ? readdirSync(liveDir(dataRoot))
          .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
          .map((f) => f.slice(0, 10))
          .sort()
      : [];
    const files = new Map<string, LiveLine[]>();
    for (const d of existing) files.set(d, (await readDay(dayPath(d))) ?? []);
    days = values['no-backfill']
      ? []
      : backfillDays(today, existing[0] ?? null, files, wanted, isTradingDay);
    if (isTradingDay(today)) {
      if (sessionOver()) days.push(today);
      else console.log('before 15:30 IST: today is not read yet');
    }
  }
  const previous = new Map<string, LiveLine[]>();
  const toRead = new Map<string, string[]>(); // section -> days
  for (const day of days) {
    const prev = (await readDay(dayPath(day))) ?? [];
    previous.set(day, prev);
    for (const k of sectionsToRead(prev, wanted, values.force)) {
      toRead.set(k, [...(toRead.get(k) ?? []), day]);
    }
  }
  if (!toRead.size) {
    console.log(`nothing to read: ${days.length ? days.join(', ') : 'no day'} already captured`);
    return 0;
  }

  const sections: Section[] = [];
  for (const [k, ds] of toRead) {
    console.log(`reading ${k} for ${ds.join(', ')}`);
    if (k === sectionKey('algotest', 'all')) {
      sections.push(
        ...(await captureAlgotest(
          ds,
          today,
          join(dataRoot, 'rotation', 'algotest', 'ledger.jsonl'),
        )),
      );
    } else {
      const broker = k.split('.')[1] as LiveBroker;
      sections.push(...(await captureQuantiply(ds, today, broker, dataRoot)));
    }
  }

  for (const day of days) {
    const mine = sections.filter((s) => s.section.day === day);
    if (!mine.length) continue;
    const merged = mergeCapture(previous.get(day) ?? [], mine);
    console.log(`${day}:`);
    for (const line of summarizeCapture(merged)) console.log(`  ${line}`);
    for (const s of mine) {
      for (const l of s.strategies) {
        const pnl = l.pnl === null ? 'did not trade' : l.pnl.toFixed(2);
        const entry = l.fills?.[0]?.entry?.at.slice(11, 16);
        const legs = l.fills?.length ? ` · ${l.fills.length} fills from ${entry}` : '';
        const runs = (l.runs ?? 0) > 1 ? ` · ${l.runs} runs` : '';
        const open = l.open_legs ? ` · ${l.open_legs} OPEN` : '';
        console.log(
          `    ${l.platform}/${l.broker} ${l.source.padEnd(13)} ${l.name}  x${l.multiplier ?? '?'}  ${pnl}${legs}${runs}${open}`,
        );
      }
    }
    if (!dryRun) {
      const path = dayPath(day);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, renderLiveFile(merged), 'utf8');
      await rename(tmp, path);
      console.log(`  written ${path}`);
    }
  }
  const tried = sections.map((s) => s.section);
  for (const s of tried.filter((x) => !x.ok)) {
    console.error(`${s.day} ${s.platform}/${s.broker}: ${s.error}`);
  }
  const code = exitCodeFor(tried);
  if (code && values['soft-fail']) {
    console.log(`not everything was read (exit ${code}); the retry job reads the rest`);
    return 0;
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(describe(error));
    process.exit(1);
  },
);
