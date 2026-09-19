import type { Page } from 'playwright';
import { BASE_URL, classifyError, visibleErrorText } from '../algotest.js';
import type { Config } from '../config.js';
import { safeScreenshot, step } from '../diagnose.js';
import { brokerNames, brokerPage, dataBrokerKeys, finvasiaForm } from '../selectors.js';
import { freshTotp } from '../totp.js';
import { type Broker, BrokerLoginError } from './types.js';

/**
 * Finvasia redirects to its own login page (user id, password and TOTP on one
 * screen), then returns to AlgoTest. AlgoTest's docs describe an inline form instead,
 * but a live capture showed otherwise. Same tab or popup is handled dynamically.
 */
export const finvasia: Broker = {
  key: 'finvasia',
  name: 'Finvasia',
  match: brokerNames.finvasia,
  dataBrokerKey: dataBrokerKeys.finvasia,

  async login(page: Page, config: Config): Promise<void> {
    const popupPromise = page
      .context()
      .waitForEvent('page', { timeout: 15_000 })
      .catch(() => null);

    await step(page, 'finvasia-click-login', async () => {
      await brokerPage.actionButton(page, dataBrokerKeys.finvasia).click();
    });

    const popup = await popupPromise;
    const target = popup ?? page;

    // Either the login form, or - if this browser already holds a Finvasia session -
    // the OAuth consent screen with no form at all.
    await step(target, 'finvasia-await-login-page', async () => {
      await finvasiaForm
        .userId(target)
        .or(finvasiaForm.authorize(target))
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
    });

    if (
      await finvasiaForm
        .authorize(target)
        .isVisible()
        .catch(() => false)
    ) {
      await step(target, 'finvasia-authorize', async () => {
        await finvasiaForm.authorize(target).click();
      });
    } else {
      await step(target, 'finvasia-fill-form', async () => {
        await finvasiaForm.userId(target).fill(config.finvasia.clientId);
        await finvasiaForm.password(target).fill(config.finvasia.password);
        // Generated last so as little of the 30-second window as possible is spent.
        await finvasiaForm.totp(target).fill(await freshTotp(config.finvasia.totpSecret));
      });

      await step(target, 'finvasia-submit', async () => {
        await finvasiaForm.submit(target).click();
      });
    }

    await target.waitForTimeout(3_000);
    if (!target.isClosed()) {
      console.log(
        `  after submit: ${new URL(target.url()).origin}${new URL(target.url()).pathname}`,
      );
      await safeScreenshot(target, 'finvasia-after-submit');
    }

    // Some sessions get the consent screen after the credentials are accepted instead.
    if (
      !target.isClosed() &&
      (await finvasiaForm
        .authorize(target)
        .isVisible()
        .catch(() => false))
    ) {
      await step(target, 'finvasia-authorize', async () => {
        await finvasiaForm.authorize(target).click();
      });
      await target.waitForTimeout(3_000);
    }

    // Only scan for errors while the login form is still showing - after a successful
    // login the tab is back on AlgoTest, where the scan could false-positive.
    const stillOnLoginForm =
      !target.isClosed() &&
      (await finvasiaForm
        .userId(target)
        .count()
        .catch(() => 0)) > 0;
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
