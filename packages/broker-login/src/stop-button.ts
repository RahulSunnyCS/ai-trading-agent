import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sendText } from '@trading/notify';
import { chromium } from 'playwright';
import { algotestLogin } from './algotest.js';
import { normalizePhone, readTelegramConfig } from './config.js';
import { describe } from './diagnose.js';
import {
  type QAlgo,
  type QLedgerRow,
  ownedIds,
  parseQLedger,
  weekdayOf,
} from './quantiply-plan.js';
import { QUANTIPLY_SITES, type QuantiplyBroker } from './quantiply-rules.js';
import {
  LoginHeld,
  LoginRefused,
  checkLoginHold,
  openQuantiply,
  quantiplyCredentials,
  quantiplyLedgerPath,
} from './quantiply-session.js';
import { redact, registerSecret } from './secrets.js';
import {
  appendStopLog,
  clearHold,
  holdPath,
  readHold,
  stopLogPath,
  writeHold,
} from './stop-hold.js';
import {
  type Report,
  type StopLog,
  algotestStopApi,
  fixtureApis,
  playwrightHttp,
  stopAlgoTest,
  stopQuantiply,
} from './stop-run.js';
import { ALGOTEST_API, csrfToken } from './strategy-delete.js';
import { type LedgerRow, istToday, owned, parseLedger } from './strategy-plan.js';

/**
 * BL-143 Phase 4: the owner's "stop everything" (Telegram, two taps; the listener is
 * `apps/scheduler/src/stop-button.ts`). The owner's answer (2026-10-20): switch off AND square
 * off, only after a second confirm tap. It sends REAL exit orders through the platforms.
 *
 *   tsx src/stop-button.ts --plan                       what a stop would do now (no network)
 *   tsx src/stop-button.ts --dry-run [--fixture f.json] the same; with a fixture, also each call
 *                                                       it would make against those lists
 *   tsx src/stop-button.ts --apply                      the stop itself (needs STOP_BUTTON=on)
 *   tsx src/stop-button.ts --clear-hold                 lift today's hold
 *
 * `--apply`, in order:
 * 1. Writes today's hold (`stop-hold.ts`): deploys, uploads and enables change nothing for the
 *    rest of the IST day, and the scheduler pauses their jobs.
 * 2. In parallel, per platform (separate accounts, separate TOTP seeds):
 *    - each Quantiply account with algos of the tool's in its ledger: log in, square off &
 *      terminate the tool's open algos, switch off its enabled ones, confirm by listing again;
 *    - AlgoTest: log in, square off on /live every running deploy named like the tool's
 *      strategies, confirm by listing again.
 *    Anything a platform offers no square-off for is reported "square off by hand"; no order is
 *    ever placed with a broker directly. Platforms and plan rules: `stop-plan.ts`.
 * 3. One Telegram report, a section per platform. Every step is a line in
 *    `TRADING_DATA_ROOT/stop/<day>.jsonl`.
 *
 * Exit: 0 everything confirmed; 3 something needs the owner; 2 refused (STOP_BUTTON not on);
 * 64 usage. Never retried by anything.
 */

const EXIT_ATTENTION = 3;
const EXIT_REFUSED = 2;
const BROKERS: QuantiplyBroker[] = ['angelone', 'finvasia'];

function istClock(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(11, 16);
}

async function readText(path: string): Promise<string> {
  return existsSync(path) ? readFile(path, 'utf8') : '';
}

interface Local {
  today: string;
  quantiply: Array<{ broker: QuantiplyBroker; ledger: QLedgerRow[]; ledgerPath: string }>;
  algotest: LedgerRow[];
}

async function readLocal(dataRoot: string): Promise<Local> {
  const today = istToday();
  const quantiply: Local['quantiply'] = [];
  for (const broker of BROKERS) {
    const ledgerPath = quantiplyLedgerPath(dataRoot, broker);
    quantiply.push({ broker, ledgerPath, ledger: parseQLedger(await readText(ledgerPath)) });
  }
  const algotest = parseLedger(
    await readText(join(dataRoot, 'rotation', 'algotest', 'ledger.jsonl')),
  );
  return { today, quantiply, algotest };
}

/** What the confirm tap will do, from the local ledgers and `.env` only (no login). */
export function previewText(local: Local, env: NodeJS.ProcessEnv): string {
  const lines: string[] = [];
  const problems: string[] = [];
  if (env.STOP_BUTTON?.trim().toLowerCase() !== 'on')
    problems.push('STOP_BUTTON is not "on" in .env: the stop would refuse');
  lines.push(
    `If you tap "Yes, stop and square off", now (${local.today} ${istClock()} IST):`,
    '',
    '1. HOLD for the rest of today: AlgoTest deploys and uploads, Quantiply uploads and enables change nothing; the scheduler pauses those jobs. The 15:40 Quantiply switch-off still runs.',
  );
  const weekday = weekdayOf(local.today);
  let n = 2;
  for (const q of local.quantiply) {
    const site = QUANTIPLY_SITES[q.broker];
    const mine = [...ownedIds(q.ledger).values()];
    if (!mine.length) {
      lines.push(`${n}. ${site.name}: nothing of the tool's in its ledger: not logged in.`);
    } else {
      const todays = mine.filter((r) => r.weekday === weekday).map((r) => r.name);
      lines.push(
        `${n}. ${site.name} (${mine.length} algo(s) of the tool's${todays.length ? `; today's: ${todays.join(', ')}` : ''}): log in; SQUARE OFF & TERMINATE each one with a trade open (Quantiply closes its positions); SWITCH OFF each enabled one, any weekday. Your own algos are not touched.`,
      );
      try {
        quantiplyCredentials(q.broker, env);
      } catch (error) {
        problems.push(`${site.name}: ${describe(error)}`);
      }
    }
    n += 1;
  }
  const uploaded = [...owned(local.algotest).keys()];
  const todays = local.algotest
    .filter(
      (r) => r.ok && r.action === 'upload' && r.day === local.today && uploaded.includes(r.name),
    )
    .map((r) => r.name);
  lines.push(
    `${n}. AlgoTest /live: log in; SQUARE OFF every running deploy named "T1 · …" or "Core · …"${todays.length ? ` (uploaded for today: ${[...new Set(todays)].join(', ')})` : ''}, whoever deployed it. Other deploys are not touched.`,
  );
  if (!env.ALGOTEST_PHONE?.trim() || !env.ALGOTEST_PASSWORD?.trim())
    problems.push('AlgoTest: ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env');
  lines.push(
    '',
    'Square off sends real exit orders through the platforms. Anything a platform cannot square off is reported "square off by hand"; nothing is ever ordered with a broker directly. The result comes back here, per platform.',
  );
  if (problems.length) lines.push('', ...problems.map((p) => `⚠️ ${p}`));
  return lines.join('\n');
}

async function deployLedgerRecorder(ledgerPath: string, broker: QuantiplyBroker, today: string) {
  const path = join(
    dirname(ledgerPath),
    broker === 'angelone' ? 'deploy-ledger.jsonl' : `deploy-ledger-${broker}.jsonl`,
  );
  return async (row: Record<string, unknown>) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      `${JSON.stringify({ at: new Date().toISOString(), session: today, mode: 'stop', ...row })}\n`,
      'utf8',
    );
  };
}

async function quantiplyAccount(
  q: Local['quantiply'][number],
  today: string,
  log: StopLog,
  headed: boolean,
): Promise<Report> {
  const site = QUANTIPLY_SITES[q.broker];
  if (!ownedIds(q.ledger).size) {
    return { platform: site.name, ok: true, lines: ["nothing of the tool's: not logged in"] };
  }
  const stateDir = dirname(q.ledgerPath);
  try {
    const creds = quantiplyCredentials(q.broker);
    await checkLoginHold(creds, stateDir);
    await log({ platform: site.name, step: 'login' });
    const api = await openQuantiply(creds, stateDir, { headed, retryTotpOnce: true });
    await log({ platform: site.name, step: 'logged_in' });
    const record = await deployLedgerRecorder(q.ledgerPath, q.broker, today);
    return await stopQuantiply(site.name, api, q.ledger, log, {
      dryRun: false,
      record: (row) => record(row).catch(() => undefined),
    });
  } catch (error) {
    const why =
      error instanceof LoginHeld || error instanceof LoginRefused
        ? `login refused or held: ${describe(error)}`
        : describe(error);
    await log({ platform: site.name, step: 'error', ok: false, detail: why });
    return {
      platform: site.name,
      ok: false,
      lines: [
        `❌ ${why}`,
        '⚠️ nothing was changed here: square off and switch off by hand in Quantiply',
      ],
    };
  }
}

async function algotest(log: StopLog, headed: boolean): Promise<Report> {
  const phone = process.env.ALGOTEST_PHONE?.trim();
  const password = process.env.ALGOTEST_PASSWORD?.trim();
  if (!phone || !password) {
    return {
      platform: 'AlgoTest',
      ok: false,
      lines: [
        '❌ ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env: square off by hand on algotest.in/live',
      ],
    };
  }
  registerSecret(password);
  const browser = await chromium.launch({ headless: !headed });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await log({ platform: 'AlgoTest', step: 'login' });
    await algotestLogin(page, { phone: normalizePhone(phone), password });
    const csrf = await csrfToken(context);
    registerSecret(csrf);
    await log({ platform: 'AlgoTest', step: 'logged_in' });
    return await stopAlgoTest(
      algotestStopApi(playwrightHttp(context.request, csrf, ALGOTEST_API)),
      log,
      {
        dryRun: false,
      },
    );
  } catch (error) {
    await log({ platform: 'AlgoTest', step: 'error', ok: false, detail: describe(error) });
    return {
      platform: 'AlgoTest',
      ok: false,
      lines: [`❌ ${describe(error)}`, '⚠️ square off by hand on algotest.in/live'],
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function reportText(day: string, hold: string, reports: Report[], logPath: string): string {
  const ok = reports.every((r) => r.ok);
  const head = ok
    ? `🛑 Stop ${day} ${istClock()} IST: done, every platform confirmed`
    : `⚠️ Stop ${day} ${istClock()} IST: CHECK BY HAND (below)`;
  const out = [head, hold];
  for (const r of reports)
    out.push('', `${r.ok ? '✅' : '⚠️'} ${r.platform}`, ...r.lines.map((l) => `  ${l}`));
  out.push('', `Log: ${logPath}`);
  return out.join('\n');
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      plan: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      fixture: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'clear-hold': { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
      by: { type: 'string' },
    },
  });
  const modes = [values.plan, values['dry-run'], values.apply, values['clear-hold']].filter(
    Boolean,
  );
  if (modes.length !== 1 || (values.fixture && !values['dry-run'])) {
    console.error('usage: --plan | --dry-run [--fixture <file.json>] | --apply | --clear-hold');
    return 64;
  }
  if (existsSync('.env')) process.loadEnvFile('.env');
  const dataRoot = process.env.TRADING_DATA_ROOT?.trim();
  if (!dataRoot) {
    console.error(
      'TRADING_DATA_ROOT is not set: the ledgers, the hold and the stop log live there',
    );
    return 1;
  }
  const today = istToday();

  if (values['clear-hold']) {
    const removed = await clearHold(dataRoot, today);
    await appendStopLog(dataRoot, { who: 'runner', step: 'clear_hold', removed });
    console.log(removed ? `today's hold removed (${holdPath(dataRoot, today)})` : 'no hold today');
    return 0;
  }

  const local = await readLocal(dataRoot);
  if (values.plan || values['dry-run']) {
    console.log(previewText(local, process.env));
    const hold = readHold(dataRoot, today);
    if (hold) console.log(`\n(today is already held since ${hold.at})`);
    if (!values.fixture) return 0;
    // The fixture's lists, every write refused: shows each call a stop would make, sends none.
    const fixture = JSON.parse(await readFile(resolve(values.fixture), 'utf8')) as {
      quantiply?: Record<string, QAlgo[]>;
      algotest?: unknown;
    };
    const apis = fixtureApis(fixture);
    const quiet: StopLog = async () => undefined;
    console.log('\nDry run against the fixture (no call is sent):');
    for (const q of local.quantiply) {
      const api = apis.quantiply(q.broker);
      if (!api) continue;
      const r = await stopQuantiply(QUANTIPLY_SITES[q.broker].name, api, q.ledger, quiet, {
        dryRun: true,
      });
      console.log(`${r.platform}:\n  ${r.lines.join('\n  ')}`);
    }
    if (apis.algotest) {
      const r = await stopAlgoTest(apis.algotest, quiet, { dryRun: true });
      console.log(`${r.platform}:\n  ${r.lines.join('\n  ')}`);
    }
    return 0;
  }

  // --apply
  const log: StopLog = (row) => appendStopLog(dataRoot, { who: 'runner', ...row });
  if (process.env.STOP_BUTTON?.trim().toLowerCase() !== 'on') {
    await log({ step: 'refused', why: 'STOP_BUTTON is not on' });
    console.error('STOP_BUTTON is not "on": nothing done');
    return EXIT_REFUSED;
  }
  await log({ step: 'start', by: values.by ?? 'manual' });
  let hold: string;
  try {
    const path = await writeHold(dataRoot, values.by ?? 'stop-button.ts --apply');
    hold = '✅ Hold: deploys, uploads and enables are held until midnight IST';
    await log({ step: 'hold', ok: true, path });
  } catch (error) {
    hold = `❌ Hold NOT written (${describe(error)}): a deploy or enable could still run today`;
    await log({ step: 'hold', ok: false, detail: describe(error) });
  }
  const reports = await Promise.all([
    ...local.quantiply.map((q) => quantiplyAccount(q, today, log, values.headed)),
    algotest(log, values.headed),
  ]);
  const text = reportText(today, hold, reports, stopLogPath(dataRoot, today));
  console.log(text);
  await sendText(readTelegramConfig(), redact(text)).catch(() => undefined);
  const ok = reports.every((r) => r.ok) && hold.startsWith('✅');
  await log({ step: 'end', ok });
  return ok ? 0 : EXIT_ATTENTION;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch(async (error: unknown) => {
      const text = `⚠️ Stop button runner stopped: ${describe(error)}. Square off and switch off by hand on Quantiply and algotest.in/live`;
      console.error(text);
      if (process.argv.includes('--apply')) {
        await Promise.resolve()
          .then(() => sendText(readTelegramConfig(), redact(text)))
          .catch(() => undefined);
      }
      process.exit(EXIT_ATTENTION);
    });
}
