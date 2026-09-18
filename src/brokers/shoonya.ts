import type { Page } from 'playwright';
import type { Config } from '../config.js';
import { classifyError, visibleErrorText } from '../algotest.js';
import { step } from '../diagnose.js';
import { brokerNames, brokerPage, shoonyaForm } from '../selectors.js';
import { freshTotp } from '../totp.js';
import { BrokerLoginError, type Broker } from './types.js';

/**
 * Shoonya logs in entirely on AlgoTest: clicking Login reveals an inline form asking
 * for the account password and a rotating TOTP code. The client ID is already stored
 * in the AlgoTest broker config.
 */
export const shoonya: Broker = {
  key: 'shoonya',
  name: 'Finvasia',
  match: brokerNames.shoonya,

  async login(page: Page, config: Config): Promise<void> {
    const card = brokerPage.card(page, brokerNames.shoonya);

    await step(page, 'shoonya-click-login', async () => {
      await brokerPage.loginButton(card).click();
    });

    await step(page, 'shoonya-fill-form', async () => {
      const totpField = shoonyaForm.totp(page);
      await totpField.waitFor({ state: 'visible', timeout: 20_000 });

      await shoonyaForm.password(page).fill(config.shoonya.password);
      // Filled last, and only once the form is definitely ready, to spend as little
      // of the 30-second TOTP window as possible before submitting.
      await totpField.fill(await freshTotp(config.shoonya.totpSecret));
    });

    await step(page, 'shoonya-submit', async () => {
      await shoonyaForm.submit(page).click();
    });

    await page.waitForTimeout(3_000);
    const error = await visibleErrorText(page);
    if (error) throw new BrokerLoginError(error, classifyError(error));
  },
};
