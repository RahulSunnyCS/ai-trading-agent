import type { Page } from 'playwright';
import type { Config } from '../config.js';
import { BASE_URL, classifyError, visibleErrorText } from '../algotest.js';
import { safeScreenshot, step } from '../diagnose.js';
import { brokerNames, brokerPage, dataBrokerKeys, shoonyaForm } from '../selectors.js';
import { freshTotp } from '../totp.js';
import { BrokerLoginError, type Broker } from './types.js';

/**
 * Finvasia redirects to its own login page (user id, password and TOTP on one
 * screen), then returns to AlgoTest. AlgoTest's docs describe an inline form instead,
 * but a live capture showed otherwise. Same tab or popup is handled dynamically.
 */
export const shoonya: Broker = {
  key: 'shoonya',
  name: 'Finvasia',
  match: brokerNames.shoonya,
  dataBrokerKey: dataBrokerKeys.shoonya,

  async login(page: Page, config: Config): Promise<void> {
    const popupPromise = page
      .context()
      .waitForEvent('page', { timeout: 15_000 })
      .catch(() => null);

    await step(page, 'shoonya-click-login', async () => {
      await brokerPage.actionButton(page, dataBrokerKeys.shoonya).click();
    });

    const popup = await popupPromise;
    const target = popup ?? page;

    // Either the login form, or - if this browser already holds a Finvasia session -
    // the OAuth consent screen with no form at all.
    await step(target, 'shoonya-await-login-page', async () => {
      await shoonyaForm
        .userId(target)
        .or(shoonyaForm.authorize(target))
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
    });

    if (await shoonyaForm.authorize(target).isVisible().catch(() => false)) {
      await step(target, 'shoonya-authorize', async () => {
        await shoonyaForm.authorize(target).click();
      });
    } else {
      await step(target, 'shoonya-fill-form', async () => {
        await shoonyaForm.userId(target).fill(config.shoonya.clientId);
        await shoonyaForm.password(target).fill(config.shoonya.password);
        // Generated last so as little of the 30-second window as possible is spent.
        await shoonyaForm.totp(target).fill(await freshTotp(config.shoonya.totpSecret));
      });

      await step(target, 'shoonya-submit', async () => {
        await shoonyaForm.submit(target).click();
      });
    }

    await target.waitForTimeout(3_000);
    if (!target.isClosed()) {
      console.log(`  after submit: ${new URL(target.url()).origin}${new URL(target.url()).pathname}`);
      await safeScreenshot(target, 'shoonya-after-submit');
    }

    // Some sessions get the consent screen after the credentials are accepted instead.
    if (!target.isClosed() && (await shoonyaForm.authorize(target).isVisible().catch(() => false))) {
      await step(target, 'shoonya-authorize', async () => {
        await shoonyaForm.authorize(target).click();
      });
      await target.waitForTimeout(3_000);
    }

    // Only scan for errors while the login form is still showing - after a successful
    // login the tab is back on AlgoTest, where the scan could false-positive.
    const stillOnLoginForm =
      !target.isClosed() && (await shoonyaForm.userId(target).count().catch(() => 0)) > 0;
    const error = stillOnLoginForm ? await visibleErrorText(target) : '';
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
