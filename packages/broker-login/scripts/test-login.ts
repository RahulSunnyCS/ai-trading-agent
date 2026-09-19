import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { algotestLogin, openMyBrokers, readBrokerState } from '../src/algotest.js';
import { angelone } from '../src/brokers/angelone.js';
import { shoonya } from '../src/brokers/shoonya.js';
import type { Broker } from '../src/brokers/types.js';
import { normalizePhone } from '../src/config.js';
import { describe, dumpHtml, safeScreenshot } from '../src/diagnose.js';
import { registerSecret } from '../src/secrets.js';
import { brokerPage } from '../src/selectors.js';

/**
 * Connectivity + selector health check - works any time of day, unlike `npm run
 * login`. It signs into AlgoTest for real and reads each broker's card, but never
 * clicks Login, so it needs no broker secrets (Shoonya's aren't set up yet) and
 * can't touch a live broker session either way. AlgoTest itself disables the actual
 * login button outside 08:15-15:40 IST - that gate is on their side, not something
 * any script can test around, so this deliberately doesn't try.
 */

if (existsSync('.env')) process.loadEnvFile('.env');

const rawPhone = process.env.ALGOTEST_PHONE?.trim();
const password = process.env.ALGOTEST_PASSWORD?.trim();
if (!rawPhone || !password) {
  console.error('Missing ALGOTEST_PHONE / ALGOTEST_PASSWORD - copy .env.example to .env first.');
  process.exit(1);
}
registerSecret(password);
const phone = normalizePhone(rawPhone);

const ALL_BROKERS: Broker[] = [angelone, shoonya];

async function main(credentials: { phone: string; password: string }): Promise<number> {
  const headed = process.env.HEADED === '1';
  // Headed mode exists so a human can watch it - on a fast local run, every step
  // otherwise completes before the window is even drawn. 400ms/action and a pause
  // at the end (both overridable) make that actually possible.
  const slowMo = Number(process.env.SLOW_MO ?? (headed ? 400 : 0));
  const holdMs = Number(process.env.HOLD_MS ?? (headed ? 6_000 : 0));

  const browser = await chromium.launch({ headless: !headed, slowMo });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  let ok = true;

  try {
    await algotestLogin(page, credentials);
    console.log('AlgoTest login: OK');

    await openMyBrokers(page);
    console.log('My Brokers tab: OK\n');

    for (const broker of ALL_BROKERS) {
      const state = await readBrokerState(page, broker);
      if (state === 'unknown') {
        ok = false;
        await safeScreenshot(page, `${broker.key}-row-not-found`);
        await dumpHtml(page, `${broker.key}-row-not-found`);
        console.log(`${broker.name}: FAIL - row not found, selector may have changed`);
        continue;
      }

      const clickable = (await brokerPage.actionButton(page, broker.dataBrokerKey).count()) > 0;
      const window = clickable ? 'login button present' : 'outside 08:15-15:40 IST window';
      console.log(`${broker.name}: OK - status "${state}" (${window})`);
    }
  } catch (error) {
    ok = false;
    console.error(`\nfatal: ${describe(error)}`);
  } finally {
    if (holdMs > 0) {
      console.log(`\nholding the window open for ${Math.round(holdMs / 1000)}s...`);
      await page.waitForTimeout(holdMs).catch(() => undefined);
    }
    await browser.close().catch(() => undefined);
  }

  console.log(ok ? '\nall selectors resolved' : '\nsome selectors need attention - see artifacts/');
  return ok ? 0 : 1;
}

main({ phone, password }).then((code) => process.exit(code));
