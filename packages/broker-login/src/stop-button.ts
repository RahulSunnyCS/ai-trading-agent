import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sendTextChecked } from '@trading/notify';
import { chromium } from 'playwright';
import { algotestLogin } from './algotest.js';
import { readAutomation } from './automation-settings.js';
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
  quantiplyDeployLedgerPath,
  quantiplyLedgerPath,
} from './quantiply-session.js';
import { redact, registerSecret } from './secrets.js';
import {
  type HoldWrite,
  appendStopLog,
  clearHold,
  holdPath,
  markStopRunning,
  otherStopRunning,
  readHold,
  stateHoldPath,
  stopLogPath,
  writeHold,
} from './stop-hold.js';
import { capped, stopSessions, toolMatcher } from './stop-plan.js';
import {
  type Report,
  type Sent,
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
 *   tsx src/stop-button.ts --clear-hold                 lift the hold (Telegram's Resume does this)
 *
 * `--apply`, in order:
 * 1. Writes the hold (`stop-hold.ts`: `TRADING_DATA_ROOT/stop/HOLD.json` and a copy in the
 *    scheduler's state dir), each read back. If it is saved nowhere the stop still squares off
 *    and switches off (squaring off is the point of the button), and says "HOLD NOT SAVED"
 *    first, in its own message and at the top of the report; the scheduler keeps the hold in
 *    memory meanwhile. The hold lasts until the owner lifts it: uploads, deploys and enables
 *    change nothing, and the scheduler refuses their jobs.
 * 2. Each platform in its own path, in parallel (separate accounts, separate TOTP seeds), every
 *    path in its own try and settled on its own, so one failing (a browser that will not start)
 *    never cuts another short:
 *    - each Quantiply account: its ledger must be readable (a missing one with credentials set is
 *      "could not tell what is the tool's: check by hand", never a green line); log in, square off
 *      & terminate the tool's open algos, switch off its enabled ones, in passes, confirm;
 *    - AlgoTest: log in, square off on /live every running deploy of the tool's, in passes,
 *      waiting while AlgoTest shows them squaring off, confirm.
 *    Anything a platform offers no square-off for is reported "square off by hand"; no order is
 *    ever placed with a broker directly. Platforms and plan rules: `stop-plan.ts`.
 * 3. The Telegram report, a section per platform, split into parts under Telegram's limit. If it
 *    cannot be delivered, a second short message says so, and the exit is 4.
 *
 * Exit: 0 everything confirmed; 3 something needs the owner; 4 the report was not delivered;
 * 2 refused (STOP_BUTTON not on); 64 usage. Never retried by anything.
 */

const EXIT_ATTENTION = 3;
const EXIT_UNREPORTED = 4;
const EXIT_REFUSED = 2;
const BROKERS: QuantiplyBroker[] = ['angelone', 'finvasia'];

function istClock(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(11, 16);
}

interface Account {
  broker: QuantiplyBroker;
  ledgerPath: string;
  ledger: QLedgerRow[];
  /** set when the tool cannot tell what is its own on this account: fail closed */
  problem: string | null;
  /** no ledger, and Settings › Automation gives the account no list: the tool never used it */
  unused: boolean;
}

interface Local {
  today: string;
  quantiply: Account[];
  algotest: LedgerRow[];
  algotestNote: string | null;
}

function hasCredentials(broker: QuantiplyBroker, env: NodeJS.ProcessEnv): boolean {
  try {
    quantiplyCredentials(broker, env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does Settings › Automation give this Quantiply account a list or uploads? Unreadable settings
 * count as yes: a missing ledger then fails closed.
 */
function usedByTool(broker: QuantiplyBroker): boolean {
  try {
    const row = readAutomation().rows[`quantiply.${broker}`];
    return !row || row.upload || row.list !== 'none';
  } catch {
    return true;
  }
}

async function readLocal(dataRoot: string | undefined): Promise<Local> {
  const today = istToday();
  const quantiply: Account[] = [];
  for (const broker of BROKERS) {
    const ledgerPath = quantiplyLedgerPath(dataRoot ?? '(TRADING_DATA_ROOT not set)', broker);
    const a: Account = { broker, ledgerPath, ledger: [], problem: null, unused: false };
    if (!dataRoot) {
      a.problem = 'TRADING_DATA_ROOT is not set, so its ledger cannot be read';
    } else if (!existsSync(ledgerPath)) {
      // Fail closed unless the settings say the tool never puts algos on this account.
      if (usedByTool(broker)) a.problem = `its ledger is missing (${ledgerPath})`;
      else a.unused = true;
    } else {
      try {
        a.ledger = parseQLedger(await readFile(ledgerPath, 'utf8'));
      } catch (error) {
        a.problem = `its ledger could not be read (${describe(error)})`;
      }
    }
    quantiply.push(a);
  }
  const algotestPath = join(dataRoot ?? '', 'rotation', 'algotest', 'ledger.jsonl');
  let algotest: LedgerRow[] = [];
  let algotestNote: string | null = null;
  try {
    if (!dataRoot) algotestNote = 'TRADING_DATA_ROOT not set: matched by the name prefixes alone';
    else if (existsSync(algotestPath)) algotest = parseLedger(await readFile(algotestPath, 'utf8'));
    else algotestNote = 'no uploader ledger: matched by the name prefixes alone';
  } catch (error) {
    algotestNote = `uploader ledger unreadable (${describe(error)}): matched by the name prefixes alone`;
  }
  return { today, quantiply, algotest, algotestNote };
}

const UNKNOWN = "could not tell what is the tool's: check Quantiply by hand";

/** What the confirm tap will do, from the local ledgers and `.env` only (no login). */
export function previewText(local: Local, env: NodeJS.ProcessEnv): string {
  const lines: string[] = [];
  const problems: string[] = [];
  if (env.STOP_BUTTON?.trim().toLowerCase() !== 'on')
    problems.push('STOP_BUTTON is not "on" in the repo-root .env: the stop would refuse');
  lines.push(
    `If you tap "Yes, stop and square off", now (${local.today} ${istClock()} IST):`,
    '',
    '1. HOLD until you lift it (Resume in Telegram): AlgoTest deploys and uploads, Quantiply uploads and enables change nothing, from today on; the scheduler refuses those jobs. The 15:40 Quantiply switch-off still runs.',
  );
  const weekday = weekdayOf(local.today);
  let n = 2;
  for (const q of local.quantiply) {
    const site = QUANTIPLY_SITES[q.broker];
    const mine = [...ownedIds(q.ledger).values()];
    if (q.problem) {
      lines.push(`${n}. ${site.name}: ⚠️ ${q.problem}: ${UNKNOWN}.`);
    } else if (q.unused) {
      lines.push(
        `${n}. ${site.name}: not used by the tool (Settings › Automation gives it no list; no ledger): nothing to do.`,
      );
    } else if (!mine.length) {
      lines.push(`${n}. ${site.name}: nothing of the tool's in its ledger: not logged in.`);
    } else {
      const todays = mine.filter((r) => r.weekday === weekday).map((r) => r.name);
      lines.push(
        `${n}. ${site.name} (${mine.length} algo(s) of the tool's${todays.length ? `; today's: ${todays.join(', ')}` : ''}): log in; SQUARE OFF & TERMINATE each one with a trade open (Quantiply closes its positions); SWITCH OFF each enabled one, any weekday. Your own algos are not touched.`,
      );
      if (!hasCredentials(q.broker, env))
        problems.push(`${site.name}: its login is missing from .env: ${UNKNOWN}`);
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
    `${n}. AlgoTest /live: log in; SQUARE OFF every running deploy of the tool's (a strategy it uploaded, or named "T1 · …" / "Core · …")${todays.length ? `, uploaded for today: ${[...new Set(todays)].join(', ')}` : ''}, whoever deployed it. Other deploys are not touched.`,
  );
  if (local.algotestNote) lines.push(`   (${local.algotestNote})`);
  if (!env.ALGOTEST_PHONE?.trim() || !env.ALGOTEST_PASSWORD?.trim())
    problems.push('AlgoTest: ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env');
  lines.push(
    '',
    'Square off sends real exit orders through the platforms. Anything a platform cannot square off is reported "square off by hand"; nothing is ever ordered with a broker directly. The result comes back here, per platform.',
  );
  if (problems.length) lines.push('', ...problems.map((p) => `⚠️ ${p}`));
  return lines.join('\n');
}

/**
 * Rows in the account's deploy ledger for each stop call, under today AND the next session of
 * the algo's weekday, so neither today's nor that session's enable switches it back on.
 */
function deployLedgerRecorder(q: Account, today: string) {
  const path = quantiplyDeployLedgerPath(dirname(q.ledgerPath), q.broker);
  return async (row: Record<string, unknown>, algo: QAlgo) => {
    await mkdir(dirname(path), { recursive: true });
    const at = new Date().toISOString();
    const lines = stopSessions(today, algo.day).map(
      (session) => `${JSON.stringify({ at, session, mode: 'stop', ...row })}\n`,
    );
    await appendFile(path, lines.join(''), 'utf8');
  };
}

/**
 * Today's square-offs from the stop log (`stop/<day>.jsonl`), per platform: every id an earlier
 * stop sent (answered) or may have sent (no answer). They are waited on and reported, never sent
 * again. An unreadable log gives none (the platforms still list what is open).
 */
export async function priorSquareOffs(
  dataRoot: string | undefined,
  day: string,
): Promise<Map<string, Sent>> {
  const out = new Map<string, Sent>();
  if (!dataRoot) return out;
  let text = '';
  try {
    text = await readFile(stopLogPath(dataRoot, day), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.who !== 'runner' || (r.step !== 'sq_off_terminate' && r.step !== 'square_off')) continue;
    if (r.ok !== true && r.maybe !== true) continue;
    if (typeof r.id !== 'string' || typeof r.platform !== 'string') continue;
    const at =
      typeof r.at === 'string'
        ? new Date(Date.parse(r.at) + 330 * 60_000).toISOString().slice(11, 16)
        : '?';
    const sent = out.get(r.platform) ?? new Map();
    if (!sent.has(r.id)) sent.set(r.id, { name: String(r.name ?? r.id), at, earlier: true });
    out.set(r.platform, sent);
  }
  return out;
}

/** Lines naming an earlier stop's square-offs when this run could not even look at them. */
function earlierLines(prior: Sent | undefined, where: string): string[] {
  if (!prior?.size) return [];
  const names = capped([...prior.values()].map((s) => `${s.name} (sent ${s.at})`));
  return [
    `⏳ an earlier stop today already sent the square-off for: ${names}. Do NOT exit these at the broker: open ${where} first`,
  ];
}

async function quantiplyAccount(
  q: Account,
  today: string,
  log: StopLog,
  headed: boolean,
  prior?: Sent,
): Promise<Report> {
  const site = QUANTIPLY_SITES[q.broker];
  if (q.problem) {
    await log({ platform: site.name, step: 'refused', detail: q.problem });
    return { platform: site.name, ok: false, lines: [`⚠️ ${q.problem}: ${UNKNOWN}`] };
  }
  if (q.unused) {
    return {
      platform: site.name,
      ok: true,
      lines: [
        'not used by the tool (Settings › Automation gives it no list; no ledger): nothing to do',
      ],
    };
  }
  if (!ownedIds(q.ledger).size) {
    return { platform: site.name, ok: true, lines: ["nothing of the tool's: not logged in"] };
  }
  const stateDir = dirname(q.ledgerPath);
  try {
    const creds = quantiplyCredentials(q.broker);
    await checkLoginHold(creds, stateDir);
    await log({ platform: site.name, step: 'login' });
    // the account's login lock and TOTP stamp: never a code from a window another run typed in
    const api = await openQuantiply(creds, stateDir, { headed, retryTotpOnce: true });
    await log({ platform: site.name, step: 'logged_in' });
    const record = deployLedgerRecorder(q, today);
    return await stopQuantiply(site.name, api, q.ledger, log, {
      dryRun: false,
      ...(prior ? { prior } : {}),
      record: (row, algo) =>
        record(row, algo).catch((error) =>
          log({ platform: site.name, step: 'ledger_row_failed', detail: describe(error) }),
        ),
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
        ...earlierLines(prior, 'Quantiply'),
        prior?.size
          ? '⚠️ this run changed nothing here: check Quantiply by hand'
          : '⚠️ nothing was changed here: square off and switch off by hand in Quantiply',
      ],
    };
  }
}

async function algotest(
  local: Local,
  log: StopLog,
  headed: boolean,
  prior?: Sent,
): Promise<Report> {
  const phone = process.env.ALGOTEST_PHONE?.trim();
  const password = process.env.ALGOTEST_PASSWORD?.trim();
  if (!phone || !password) {
    return {
      platform: 'AlgoTest',
      ok: false,
      lines: [
        '❌ ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env: square off by hand on algotest.in/live',
        ...earlierLines(prior, 'algotest.in/live'),
      ],
    };
  }
  registerSecret(password);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: !headed });
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
    const report = await stopAlgoTest(
      algotestStopApi(playwrightHttp(context.request, csrf, ALGOTEST_API)),
      log,
      {
        dryRun: false,
        isTool: toolMatcher(local.algotest),
        today: local.today,
        ...(prior ? { prior } : {}),
      },
    );
    if (local.algotestNote) report.lines.push(`(${local.algotestNote})`);
    return report;
  } catch (error) {
    await log({ platform: 'AlgoTest', step: 'error', ok: false, detail: describe(error) });
    return {
      platform: 'AlgoTest',
      ok: false,
      lines: [
        `❌ ${describe(error)}`,
        ...earlierLines(prior, 'algotest.in/live'),
        prior?.size
          ? '⚠️ this run changed nothing on AlgoTest: check algotest.in/live by hand'
          : '⚠️ square off by hand on algotest.in/live',
      ],
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/** Every platform's report, even when a path threw past its own catch. */
export async function settle(
  paths: Array<{ platform: string; run: () => Promise<Report> }>,
): Promise<Report[]> {
  const out = await Promise.allSettled(paths.map((p) => p.run()));
  return out.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          platform: paths[i]?.platform ?? '?',
          ok: false,
          lines: [`❌ ${describe(r.reason)}`, '⚠️ check this platform by hand'],
        },
  );
}

/** The report's first line about the hold: loud when it was not saved in both places. */
export function holdLine(h: HoldWrite): string {
  if (!h.saved.length)
    return `❌ HOLD NOT SAVED (${h.failed.join('; ')}): the tool may re-enable or upload after a scheduler restart. Stop the scheduler or fix the volume.`;
  if (h.failed.length)
    return `⚠️ Hold saved only in ${h.saved.join(', ')} (${h.failed.join('; ')}): it holds, but fix the data volume.`;
  return '✅ Hold on: no uploads, enables or deploys until you lift it (Resume)';
}

export function reportText(hold: string, reports: Report[], logPath: string): string {
  const ok = reports.every((r) => r.ok);
  const head = ok
    ? `🛑 Stop ${istToday()} ${istClock()} IST: done, every platform confirmed`
    : `⚠️ Stop ${istToday()} ${istClock()} IST: CHECK BY HAND (below)`;
  const out = [head, hold];
  for (const r of reports)
    out.push('', `${r.ok ? '✅' : '⚠️'} ${r.platform}`, ...r.lines.map((l) => `  ${l}`));
  out.push('', `Log: ${logPath}`);
  return out.join('\n');
}

/** Send, and on a failed delivery try one short message; true only if the full text arrived. */
async function deliver(text: string, short: string): Promise<boolean> {
  const config = readTelegramConfig();
  if (await sendTextChecked(config, redact(text))) return true;
  await sendTextChecked(config, redact(short));
  return false;
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
  const dataRoot = process.env.TRADING_DATA_ROOT?.trim() || undefined;
  // --apply goes on without it (squaring off is the point of the button); nothing else can
  if (!dataRoot && !values.apply && !values['clear-hold']) {
    console.error(
      'TRADING_DATA_ROOT is not set: the ledgers, the hold and the stop log live there',
    );
    return 1;
  }

  if (values['clear-hold']) {
    const removed = await clearHold(dataRoot);
    if (dataRoot)
      await appendStopLog(dataRoot, {
        who: 'runner',
        step: 'clear_hold',
        removed,
        by: values.by ?? 'manual',
      });
    console.log(
      removed
        ? `hold lifted (${[...(dataRoot ? [holdPath(dataRoot)] : []), stateHoldPath()].join(', ')}: kept, renamed, as a record)`
        : 'there was no hold',
    );
    // the listener checks the hold is gone; still there means something could not be renamed
    return readHold(dataRoot) ? 1 : 0;
  }

  const local = await readLocal(dataRoot);
  if (values.plan || values['dry-run']) {
    console.log(previewText(local, process.env));
    const hold = readHold(dataRoot);
    if (hold) console.log(`\n(the stop hold is already on, since ${hold.at})`);
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
      const r = await stopAlgoTest(apis.algotest, quiet, {
        dryRun: true,
        isTool: toolMatcher(local.algotest),
        today: local.today,
      });
      console.log(`${r.platform}:\n  ${r.lines.join('\n  ')}`);
    }
    return 0;
  }

  // --apply
  const log: StopLog = async (row) => {
    if (dataRoot) await appendStopLog(dataRoot, { who: 'runner', ...row });
    else console.log(`stop: ${redact(JSON.stringify(row))}`);
  };
  if (process.env.STOP_BUTTON?.trim().toLowerCase() !== 'on') {
    await log({ step: 'refused', why: 'STOP_BUTTON is not on' });
    console.error('REFUSED: STOP_BUTTON is not "on" in the repo-root .env');
    return EXIT_REFUSED;
  }
  await log({ step: 'start', by: values.by ?? 'manual' });
  // While the stop runs, other jobs that log in (the loss / deploy monitor) keep off the accounts.
  // one stop at a time: a second one would send square-offs the first is still waiting on
  const other = otherStopRunning(dataRoot);
  if (other) {
    await log({ step: 'refused', why: 'another stop is running', since: other.at, pid: other.pid });
    console.error(`REFUSED: a stop is already running since ${other.at} (pid ${other.pid})`);
    return EXIT_REFUSED;
  }
  const running = await markStopRunning(dataRoot);
  try {
    return await applyStop(dataRoot, local, log, values);
  } finally {
    await running();
  }
}

async function applyStop(
  dataRoot: string | undefined,
  local: Local,
  log: StopLog,
  values: { by?: string | undefined; headed: boolean },
): Promise<number> {
  // The hold first. If it cannot be saved anywhere, the stop still squares off and switches off
  // (coordinator's decision, 2026-10-20): it says so first, and loudly, and the scheduler keeps
  // the hold in memory until it restarts.
  const held = await writeHold(dataRoot, values.by ?? 'stop-button.ts --apply');
  await log({ step: 'hold', saved: held.saved, failed: held.failed });
  const hold = holdLine(held);
  // said at once, but never waited on before the square-offs start
  let early: Promise<boolean> = Promise.resolve(true);
  if (!held.saved.length || held.failed.length) {
    console.error(hold);
    early = sendTextChecked(
      readTelegramConfig(),
      redact(`${hold}\nSquaring off and switching off now; the result follows.`),
    ).catch(() => false);
  }
  const prior = await priorSquareOffs(dataRoot, local.today);
  if (prior.size) await log({ step: 'prior', platforms: [...prior.keys()] });
  const reports = await settle([
    ...local.quantiply.map((q) => ({
      platform: QUANTIPLY_SITES[q.broker].name,
      run: () =>
        quantiplyAccount(
          q,
          local.today,
          log,
          values.headed,
          prior.get(QUANTIPLY_SITES[q.broker].name),
        ),
    })),
    {
      platform: 'AlgoTest',
      run: () => algotest(local, log, values.headed, prior.get('AlgoTest')),
    },
  ]);
  const logPath = dataRoot
    ? stopLogPath(dataRoot, local.today)
    : '(no stop log: TRADING_DATA_ROOT not set; see the runner log in the scheduler log folder)';
  const text = reportText(hold, reports, logPath);
  console.log(text);
  const ok = reports.every((r) => r.ok);
  const sent = await deliver(
    text,
    `⚠️ The stop finished (${ok ? 'all confirmed' : 'CHECK BY HAND'}), but its full report could not be sent. Read ${logPath} on the laptop.`,
  );
  await log({ step: 'end', ok, reported: sent, holdWarned: await early });
  if (!sent) return EXIT_UNREPORTED;
  return ok && held.saved.length && !held.failed.length ? 0 : EXIT_ATTENTION;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch(async (error: unknown) => {
      const text = `⚠️ Stop button runner stopped: ${describe(error)}. Square off and switch off by hand on Quantiply and algotest.in/live`;
      console.error(text);
      let delivered = true;
      if (process.argv.includes('--apply')) {
        delivered = await Promise.resolve()
          .then(() => sendTextChecked(readTelegramConfig(), redact(text)))
          .catch(() => false);
      }
      // 4: the listener then says the report did not arrive, rather than nothing at all
      process.exit(delivered ? EXIT_ATTENTION : EXIT_UNREPORTED);
    });
}
