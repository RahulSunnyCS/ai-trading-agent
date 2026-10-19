import { appendFile, mkdir } from 'node:fs/promises';
import { istTimestamp, sendText } from '@trading/notify';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import {
  algotestLogin,
  classifyError,
  openMyBrokers,
  readBrokerState,
  visibleErrorText,
  waitForState,
} from './algotest.js';
import { angelone } from './brokers/angelone.js';
import { finvasia } from './brokers/finvasia.js';
import {
  type Broker,
  BrokerLoginError,
  type BrokerResult,
  type FailureKind,
  isRetryable,
} from './brokers/types.js';
import { type Config, loadConfig, readTelegramConfig } from './config.js';
import { ARTIFACTS_DIR, describe, dumpHtml, safeScreenshot } from './diagnose.js';
import { formatReport } from './notify.js';
import { installOverlayHandlers } from './overlays.js';
import { QUANTIPLY_SITES } from './quantiply-rules.js';
import { runQuantiplyShoonyaIsolated } from './quantiply-shoonya.js';
import { QUANTIPLY_NAME, runQuantiplyIsolated } from './quantiply.js';
import {
  WINDOW_CLOSES_MINUTES,
  WINDOW_OPENS_MINUTES,
  exitCode,
  istMinutesNow,
  quantiplyOrder,
} from './run-plan.js';
import { brokerPage } from './selectors.js';
import { waitForNextWindow } from './totp.js';

const ALL_BROKERS: Broker[] = [angelone, finvasia];

const MAX_ATTEMPTS = 2;

/**
 * GitHub's scheduler drifts late, which is harmless, but can also fire early. Logging
 * in before 08:15 IST gets rejected server-side, so wait it out rather than fail.
 */
async function waitForLoginWindow(config: Config): Promise<void> {
  if (config.skipWindowGuard) return;

  const now = istMinutesNow();
  if (now >= WINDOW_OPENS_MINUTES) {
    if (now > WINDOW_CLOSES_MINUTES) {
      console.warn('! past 15:40 IST - AlgoTest may reject broker logins now');
    }
    return;
  }

  const gapMinutes = WINDOW_OPENS_MINUTES - now;
  // Bounded so the sleep can never approach the workflow's 45min timeout.
  if (gapMinutes > 30) {
    console.warn(`! ${gapMinutes}min before the 08:15 IST window; continuing anyway`);
    return;
  }

  console.log(`waiting ${gapMinutes}min for the 08:15 IST broker login window`);
  await new Promise((resolve) => setTimeout(resolve, gapMinutes * 60_000 + 30_000));
}

/**
 * AlgoTest reports a refused broker login (wrong window, non-trading day, bad
 * credentials) as a toast that vanishes within seconds - far sooner than the 40s
 * state poll would notice - so look for it right after the login step. Stops early
 * once the broker shows logged in, and only returns text it can classify, so an
 * unrelated word on the page can't masquerade as a rejection.
 */
async function lookForRejection(page: Page, broker: Broker): Promise<string> {
  for (let i = 0; i < 15; i += 1) {
    if ((await readBrokerState(page, broker)) === 'logged_in') return '';
    const text = await visibleErrorText(page);
    if (text && classifyError(text) !== 'UNKNOWN') return text;
    await page.waitForTimeout(1_000);
  }
  return '';
}

async function attemptBroker(page: Page, broker: Broker, config: Config): Promise<BrokerResult> {
  const started = Date.now();
  const result = (status: BrokerResult['status'], detail: string): BrokerResult => ({
    name: broker.name,
    status,
    detail,
  });

  const initial = await readBrokerState(page, broker);
  if (initial === 'logged_in') return result('SKIPPED', 'already logged in');
  if (initial === 'unknown') {
    await safeScreenshot(page, `${broker.key}-row-not-found`);
    await dumpHtml(page, `${broker.key}-row-not-found`);
    return result('FAIL', 'row not found on My Brokers - selector may have changed');
  }

  // Outside 08:15-15:40 IST, AlgoTest swaps the Login/Re-login button for a disabled
  // "Market Closed" placeholder with no data-broker attribute at all - confirmed on a
  // live capture. Fail fast here instead of waiting out a 15s timeout on a button
  // that will never appear.
  if ((await brokerPage.actionButton(page, broker.dataBrokerKey).count()) === 0) {
    return result(
      'FAIL',
      'market closed - outside 08:15-15:40 IST login window (or not a trading day)',
    );
  }

  let lastDetail = 'unknown failure';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`\n${broker.name}: attempt ${attempt}/${MAX_ATTEMPTS}`);
    let kind: FailureKind = 'UNKNOWN';

    try {
      await broker.login(page, config);

      const rejection = await lookForRejection(page, broker);
      if (rejection) throw new BrokerLoginError(rejection, classifyError(rejection));

      const state = await waitForState(page, broker, 'logged_in');
      if (state === 'logged_in') {
        const seconds = Math.round((Date.now() - started) / 1000);
        return result('OK', `logged in (${seconds}s)`);
      }
      // login() returned without error, so the credentials went in. Resubmitting them
      // would only risk a lockout and can't fix a callback that didn't register.
      await safeScreenshot(page, `${broker.key}-row-not-updated`);
      const at = new URL(page.url()).pathname;
      return result('FAIL', `submitted but row still shows ${state} (on ${at}) - NOT retried`);
    } catch (error) {
      kind = error instanceof BrokerLoginError ? error.kind : 'UNKNOWN';
      lastDetail = describe(error);
      console.error(`  ${broker.name} failed (${kind}): ${lastDetail}`);
    }

    // Wrong password or PIN: stop immediately. Brokers lock the account after a few
    // bad attempts and unlocking is a manual support process.
    if (kind === 'CREDENTIALS_REJECTED') {
      return result('FAIL', `${lastDetail} - NOT retried, check credentials`);
    }
    if (kind === 'LOGIN_WINDOW_CLOSED') {
      return result('FAIL', `${lastDetail} - outside login window`);
    }
    if (attempt === MAX_ATTEMPTS || !isRetryable(kind)) break;

    if (kind === 'TOTP_REJECTED') await waitForNextWindow();
    await openMyBrokers(page).catch(() => undefined);
  }

  return result('FAIL', lastDetail);
}

/** The AlgoTest broker logins, in a context of their own (traced only with TRACE=1). */
async function runAlgotest(
  browser: Browser,
  config: Config,
  tracing: boolean,
): Promise<BrokerResult[]> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });

  // Close any notice that covers the page (AlgoTest, Finvasia's popup) instead of timing out on it.
  installOverlayHandlers(context);

  // Opt-in only: trace snapshots record input values, including the typed password.
  if (tracing) await context.tracing.start({ screenshots: true, snapshots: true });

  const results = await run(config, context);

  if (tracing) {
    await context.tracing.stop({ path: `${ARTIFACTS_DIR}/trace.zip` }).catch(() => undefined);
  }
  return results;
}

async function run(config: Config, context: BrowserContext): Promise<BrokerResult[]> {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  await algotestLogin(page, config.algotest);
  console.log('AlgoTest login OK');

  await openMyBrokers(page);
  console.log('My Brokers tab open');

  const brokers = config.only ? ALL_BROKERS.filter((b) => b.key === config.only) : ALL_BROKERS;

  if (brokers.length === 0) {
    throw new Error(`ONLY=${config.only} matched no broker (expected: angelone, finvasia)`);
  }

  const results: BrokerResult[] = [];
  for (const broker of brokers) {
    results.push(await attemptBroker(page, broker, config));
  }
  return results;
}

/**
 * Read independently of loadConfig() up front, so a failure IN loadConfig() (a
 * missing or misnamed secret) can still be reported - the alert path can't depend on
 * the same validation that might be what's broken. Every exit from main() past this
 * point goes through a Telegram send; nothing after it is allowed to bypass that.
 */
async function main(): Promise<number> {
  const telegram = readTelegramConfig();

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    const message = `🚨 Startup failed\nAlgoTest broker login, ${istTimestamp()} IST\n${describe(error)}`;
    console.error(message);
    await sendText(telegram, message, 'broker.algotest');
    return 1;
  }

  await mkdir(ARTIFACTS_DIR, { recursive: true }).catch(() => undefined);

  const tracing = process.env.TRACE === '1';
  const order = quantiplyOrder(
    config.quantiply && !config.quantiplyProblem,
    config.skipWindowGuard,
    istMinutesNow(),
  );
  const launch = () => chromium.launch({ headless: !config.headed, slowMo: config.slowMo });

  let results: BrokerResult[] = [];
  // A Quantiply config problem is only its own FAIL line; the AlgoTest logins still run.
  let quantiply: BrokerResult | null = config.quantiplyProblem
    ? { name: QUANTIPLY_NAME, status: 'FAIL', detail: config.quantiplyProblem }
    : null;
  let quantiplyShoonya: BrokerResult | null = null;
  let fatal: string | null = null;
  let algotestStarted = false;
  let browser: Browser | undefined;

  try {
    try {
      if (order === 'first') {
        // Before 08:16 IST the window guard would only sleep: Quantiply uses those minutes and
        // costs AlgoTest nothing.
        browser = await launch();
        quantiply = await runQuantiplyIsolated(browser, config.angelone);
        await waitForLoginWindow(config);
      } else {
        // Without Quantiply, or once the window is open: exactly as before, and the real-money
        // AlgoTest logins are never held up by Quantiply.
        await waitForLoginWindow(config);
        browser = await launch();
      }
      algotestStarted = true;
      // ONLY=none: no AlgoTest block logs in (BL-140, from the dashboard's settings).
      results = config.only === 'none' ? [] : await runAlgotest(browser, config, tracing);
    } catch (error) {
      fatal = describe(error);
      console.error(`\nfatal: ${fatal}`);
    }

    if (order === 'last') {
      try {
        browser ??= await launch();
        quantiply = await runQuantiplyIsolated(browser, config.angelone);
      } catch (error) {
        quantiply = { name: QUANTIPLY_NAME, status: 'FAIL', detail: describe(error) };
      }
    }
    // BL-140: Quantiply · Shoonya, always after the AlgoTest logins so it can never delay them.
    // Its own line; it never changes the exit code (a Shoonya failure must not make the backstop
    // log the AlgoTest brokers in again), and the backstop never repeats it (workflow).
    if (config.quantiplyShoonya) {
      try {
        browser ??= await launch();
        quantiplyShoonya = await runQuantiplyShoonyaIsolated(browser, {
          userId: config.finvasia.clientId,
          password: config.finvasia.password,
          totpSecret: config.finvasia.totpSecret,
        });
      } catch (error) {
        quantiplyShoonya = {
          name: QUANTIPLY_SITES.finvasia.name,
          status: 'FAIL',
          detail: describe(error),
        };
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  // Switched on but never reached (the browser did not start): still a line, and a failure.
  if (config.quantiply && !quantiply) {
    quantiply = { name: QUANTIPLY_NAME, status: 'FAIL', detail: 'did not run' };
  }

  const shoonyaLine = quantiplyShoonya
    ? `\n${quantiplyShoonya.status === 'OK' || quantiplyShoonya.status === 'SKIPPED' ? '✅' : '❌'} ${quantiplyShoonya.name}: ${quantiplyShoonya.detail}`
    : '';
  const body = formatReport(results, config.runUrl, quantiply) + shoonyaLine;
  const fatalLabel = quantiply && algotestStarted ? 'fatal (AlgoTest)' : 'fatal';
  const report = fatal ? `${body}\n${fatalLabel}: ${fatal}` : body;

  console.log(`\n${report}`);
  await sendText(config.telegram, report, 'broker.algotest');

  // In Actions, Quantiply's result goes to the workflow as a step output and its own step fails
  // the job; this step's conclusion stays AlgoTest's alone (run-plan.ts exitCode).
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    await appendFile(githubOutput, `quantiply=${quantiply?.status ?? 'OFF'}\n`).catch((error) =>
      console.error(`could not write the step output: ${describe(error)}`),
    );
  }
  return exitCode(results, quantiply, fatal, Boolean(githubOutput));
}

/**
 * Last-resort net: anything that escapes every try/catch above (a bug in this file
 * itself, a stray unawaited rejection) still gets one attempt at a Telegram alert
 * before the process dies, using the same env-var read as everywhere else - not
 * `config.telegram`, since config may never have loaded.
 */
function crashAlert(source: string, error: unknown): void {
  console.error(`${source}:`, describe(error));
  const message = `💥 Crashed (${source})\nAlgoTest broker login, ${istTimestamp()} IST\n${describe(error)}`;
  sendText(readTelegramConfig(), message, 'broker.algotest')
    .catch(() => undefined)
    .finally(() => process.exit(1));
}

process.on('unhandledRejection', (reason) => crashAlert('unhandled rejection', reason));
process.on('uncaughtException', (error) => crashAlert('uncaught exception', error));

main()
  .then((code) => process.exit(code))
  .catch((error) => crashAlert('main() rejected', error));
