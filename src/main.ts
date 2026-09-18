import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { algotestLogin, openMyBrokers, readBrokerState, waitForState } from './algotest.js';
import { angelone } from './brokers/angelone.js';
import { shoonya } from './brokers/shoonya.js';
import {
  BrokerLoginError,
  isRetryable,
  type Broker,
  type BrokerResult,
  type FailureKind,
} from './brokers/types.js';
import { loadConfig, type Config } from './config.js';
import { ARTIFACTS_DIR, describe, dumpHtml, safeScreenshot } from './diagnose.js';
import { formatReport, sendTelegram } from './notify.js';
import { brokerPage } from './selectors.js';
import { waitForNextWindow } from './totp.js';

const ALL_BROKERS: Broker[] = [angelone, shoonya];

/** AlgoTest rejects broker logins outside 08:30-15:28 IST. */
const WINDOW_OPENS_MINUTES = 8 * 60 + 31;
const WINDOW_CLOSES_MINUTES = 15 * 60 + 28;
const MAX_ATTEMPTS = 2;

function istMinutesNow(): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * GitHub's scheduler drifts late, which is harmless, but can also fire early. Logging
 * in before 08:30 IST gets rejected server-side, so wait it out rather than fail.
 */
async function waitForLoginWindow(config: Config): Promise<void> {
  if (config.skipWindowGuard) return;

  const now = istMinutesNow();
  if (now >= WINDOW_OPENS_MINUTES) {
    if (now > WINDOW_CLOSES_MINUTES) {
      console.warn('! past 15:28 IST - AlgoTest may reject broker logins now');
    }
    return;
  }

  const gapMinutes = WINDOW_OPENS_MINUTES - now;
  // Bounded so the sleep can never approach the workflow's 45min timeout.
  if (gapMinutes > 30) {
    console.warn(`! ${gapMinutes}min before the 08:30 IST window; continuing anyway`);
    return;
  }

  console.log(`waiting ${gapMinutes}min for the 08:30 IST broker login window`);
  await new Promise((resolve) => setTimeout(resolve, gapMinutes * 60_000 + 30_000));
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

  // Outside 08:30-15:28 IST, AlgoTest swaps the Login/Re-login button for a disabled
  // "Market Closed" placeholder with no data-broker attribute at all - confirmed on a
  // live capture. Fail fast here instead of waiting out a 15s timeout on a button
  // that will never appear.
  if ((await brokerPage.actionButton(page, broker.dataBrokerKey).count()) === 0) {
    return result('FAIL', 'market closed - outside 08:30-15:28 IST login window');
  }

  let lastDetail = 'unknown failure';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`\n${broker.name}: attempt ${attempt}/${MAX_ATTEMPTS}`);
    let kind: FailureKind = 'UNKNOWN';

    try {
      await broker.login(page, config);

      const state = await waitForState(page, broker, 'logged_in');
      if (state === 'logged_in') {
        const seconds = Math.round((Date.now() - started) / 1000);
        return result('OK', `logged in (${seconds}s)`);
      }
      lastDetail = `submitted but row still shows ${state}`;
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

async function run(config: Config, context: BrowserContext): Promise<BrokerResult[]> {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  await algotestLogin(page, config);
  console.log('AlgoTest login OK');

  await openMyBrokers(page);
  console.log('My Brokers tab open');

  const brokers = config.only
    ? ALL_BROKERS.filter((b) => b.key === config.only)
    : ALL_BROKERS;

  if (brokers.length === 0) {
    throw new Error(`ONLY=${config.only} matched no broker (expected: angelone, shoonya)`);
  }

  const results: BrokerResult[] = [];
  for (const broker of brokers) {
    results.push(await attemptBroker(page, broker, config));
  }
  return results;
}

async function main(): Promise<number> {
  const config = loadConfig();
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await waitForLoginWindow(config);

  const tracing = process.env.TRACE === '1';
  const browser = await chromium.launch({
    headless: !config.headed,
    slowMo: config.slowMo,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });

  // Opt-in only: trace snapshots record input values, including the typed password.
  if (tracing) await context.tracing.start({ screenshots: true, snapshots: true });

  let results: BrokerResult[] = [];
  let fatal: string | null = null;

  try {
    results = await run(config, context);
  } catch (error) {
    fatal = describe(error);
    console.error(`\nfatal: ${fatal}`);
  } finally {
    if (tracing) {
      await context.tracing
        .stop({ path: `${ARTIFACTS_DIR}/trace.zip` })
        .catch(() => undefined);
    }
    await browser.close().catch(() => undefined);
  }

  const report = fatal
    ? `${formatReport(results, config.runUrl)}\nfatal: ${fatal}`
    : formatReport(results, config.runUrl);

  console.log(`\n${report}`);
  await sendTelegram(config, report);

  const failed = results.some((r) => r.status === 'FAIL');
  return fatal || failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    // Config errors land here, before a browser or report exists.
    console.error('startup failed:', describe(error));
    process.exit(1);
  });
