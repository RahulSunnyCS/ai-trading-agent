import type { Page } from 'playwright';
import type { Config } from '../config.js';
import { BASE_URL, classifyError, visibleErrorText } from '../algotest.js';
import { safeScreenshot, step } from '../diagnose.js';
import { angelOneForm, brokerNames, brokerPage, dataBrokerKeys } from '../selectors.js';
import { freshTotp } from '../totp.js';
import { BrokerLoginError, type Broker } from './types.js';

const ANGEL_HOST = /angel(one|broking)/i;

/**
 * Angel One redirects to its own login page (SmartAPI publisher login) where the
 * client code, MPIN and TOTP are entered, then returns to AlgoTest. Whether that
 * happens in the same tab or a popup is handled dynamically - both are possible and
 * the recording will tell us which one it actually is.
 */
export const angelone: Broker = {
  key: 'angelone',
  name: 'Angel One',
  match: brokerNames.angelone,
  dataBrokerKey: dataBrokerKeys.angelone,

  async login(page: Page, config: Config): Promise<void> {
    const popupPromise = page
      .context()
      .waitForEvent('page', { timeout: 15_000 })
      .catch(() => null);

    await step(page, 'angelone-click-login', async () => {
      await brokerPage.actionButton(page, dataBrokerKeys.angelone).click();
    });

    const popup = await popupPromise;
    const target = popup ?? page;

    await step(target, 'angelone-await-broker-page', async () => {
      await target.waitForLoadState('domcontentloaded');
      if (!ANGEL_HOST.test(new URL(target.url()).hostname)) {
        await target.waitForURL((url) => ANGEL_HOST.test(url.hostname), { timeout: 30_000 });
      }
    });

    await step(target, 'angelone-select-totp-mode', async () => {
      const option = angelOneForm.totpModeOption(target);
      await option.waitFor({ state: 'visible', timeout: 20_000 });
      await option.click();
    });

    await step(target, 'angelone-fill-form', async () => {
      const clientCode = angelOneForm.clientCode(target);
      await clientCode.waitFor({ state: 'visible', timeout: 10_000 });
      await clientCode.fill(config.angelone.clientCode);
      await angelOneForm.mpin(target).fill(config.angelone.mpin);
      // Generated last so as little of the 30-second window as possible is spent.
      await angelOneForm.totp(target).fill(await freshTotp(config.angelone.totpSecret));
    });

    await step(target, 'angelone-submit', async () => {
      await angelOneForm.submit(target).click();
    });

    await target.waitForTimeout(3_000);
    if (!target.isClosed()) {
      console.log(`  after submit: ${new URL(target.url()).origin}${new URL(target.url()).pathname}`);
      await safeScreenshot(target, 'angelone-after-submit');
    }
    // Only scan for errors while still on Angel's page - after a successful login the
    // tab is back on AlgoTest, where the generic error-word scan could false-positive.
    const stillOnAngel = !target.isClosed() && ANGEL_HOST.test(new URL(target.url()).hostname);
    const inlineError = stillOnAngel
      ? ((await angelOneForm.error(target).innerText().catch(() => '')) || '').trim()
      : '';
    const error = inlineError || (stillOnAngel ? await visibleErrorText(target) : '');
    if (error) throw new BrokerLoginError(error, classifyError(error));

    // Wait for the round trip back to AlgoTest before the caller verifies the row.
    if (popup) {
      await popup.waitForEvent('close', { timeout: 45_000 }).catch(() => undefined);
      if (!popup.isClosed()) await popup.close().catch(() => undefined);
    } else {
      await page
        .waitForURL((url) => url.hostname.endsWith('algotest.in'), { timeout: 45_000 })
        .catch(() => undefined);
    }

    if (!page.url().includes('/broker')) {
      await page.goto(`${BASE_URL}/broker`, { waitUntil: 'domcontentloaded' });
    }
  },
};
