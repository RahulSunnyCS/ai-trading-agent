import type { Page } from 'playwright';
import { step } from './diagnose.js';
import { brokerPage, errorPatterns, loginPage } from './selectors.js';
import { BrokerLoginError, type Broker, type FailureKind } from './brokers/types.js';

export const BASE_URL = 'https://algotest.in';

export type BrokerState = 'logged_in' | 'logged_out' | 'unknown';

export interface AlgotestCredentials {
  phone: string;
  password: string;
}

/**
 * Takes just the site credentials, not the full Config, so callers that never touch
 * a broker - like the read-only test-login smoke check - don't need broker secrets
 * to exist at all.
 */
export async function algotestLogin(page: Page, credentials: AlgotestCredentials): Promise<void> {
  await step(page, 'goto-login', async () => {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  });

  await step(page, 'fill-credentials', async () => {
    await loginPage.form(page).waitFor({ state: 'visible', timeout: 30_000 });
    await loginPage.phone(page).fill(credentials.phone);
    await loginPage.password(page).fill(credentials.password);
  });

  await step(page, 'submit-login', async () => {
    await loginPage.submit(page).click();
  });

  // Either we navigate off /login, or an inline error appears. Both promises carry
  // their own catch so the losing race branch can never reject unhandled.
  const leftLoginPage = page
    .waitForURL((url) => !url.pathname.includes('/login'), { timeout: 45_000 })
    .then(() => true)
    .catch(() => false);

  const sawError = loginPage
    .error(page)
    .waitFor({ state: 'visible', timeout: 45_000 })
    .then(() => true)
    .catch(() => false);

  await Promise.race([leftLoginPage, sawError]);

  if (page.url().includes('/login')) {
    const detail = await visibleErrorText(page);
    throw new BrokerLoginError(
      `AlgoTest login did not complete${detail ? `: ${detail}` : ''}`,
      detail && errorPatterns.credentialsRejected.test(detail) ? 'CREDENTIALS_REJECTED' : 'UNKNOWN',
    );
  }
}

export async function openMyBrokers(page: Page): Promise<void> {
  await step(page, 'goto-broker', async () => {
    if (!page.url().includes('/broker')) {
      await page.goto(`${BASE_URL}/broker`, { waitUntil: 'domcontentloaded' });
    }
  });

  await step(page, 'open-my-brokers-tab', async () => {
    const tab = brokerPage.myBrokersTab(page);
    await tab.waitFor({ state: 'visible', timeout: 30_000 });
    await tab.click();
    // The tab swap is client-side; give the broker list a moment to render.
    await page.waitForTimeout(1_500);
  });
}

/**
 * Reads the "Status" badge text (e.g. "Logged in"). Anything other than exactly
 * "logged in" is treated as logged_out, which is the safe default: it just causes a
 * login attempt rather than a silent skip. Falls back to action-button presence if
 * the card itself can't be found at all.
 */
export async function readBrokerState(page: Page, broker: Broker): Promise<BrokerState> {
  const card = brokerPage.card(page, broker.match);

  if ((await card.count()) === 0) return 'unknown';

  const status = await brokerPage
    .statusText(card)
    .innerText()
    .then((text) => text.trim().toLowerCase())
    .catch(() => '');

  if (status) return status === 'logged in' ? 'logged_in' : 'logged_out';

  // Status label not found - fall back to whether the action button exists at all.
  return (await brokerPage.actionButton(page, broker.dataBrokerKey).count()) > 0
    ? 'logged_out'
    : 'unknown';
}

/**
 * Polls until the broker's row reaches the wanted state, reloading once partway
 * through because the SPA sometimes needs a refetch to reflect a new session.
 */
export async function waitForState(
  page: Page,
  broker: Broker,
  want: BrokerState,
  timeoutMs = 40_000,
): Promise<BrokerState> {
  const deadline = Date.now() + timeoutMs;
  const reloadAt = Date.now() + Math.floor(timeoutMs / 2);
  let reloaded = false;
  let last: BrokerState = 'unknown';

  while (Date.now() < deadline) {
    last = await readBrokerState(page, broker);
    if (last === want) return last;

    if (!reloaded && Date.now() > reloadAt) {
      reloaded = true;
      await page.goto(`${BASE_URL}/broker`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await openMyBrokers(page).catch(() => undefined);
      continue;
    }

    await page.waitForTimeout(2_000);
  }

  return last;
}

export async function visibleErrorText(page: Page): Promise<string> {
  const candidates = page.getByText(
    /invalid|incorrect|expired|failed|error|blocked|locked|not allowed|only possible|trading days|try again/i,
  );
  const count = Math.min(await candidates.count().catch(() => 0), 5);

  for (let i = 0; i < count; i += 1) {
    const element = candidates.nth(i);
    if (!(await element.isVisible().catch(() => false))) continue;
    const text = (await element.innerText().catch(() => ''))?.trim();
    if (text) return text.replace(/\s+/g, ' ').slice(0, 200);
  }
  return '';
}

export function classifyError(text: string): FailureKind {
  if (!text) return 'UNKNOWN';
  if (errorPatterns.loginWindowClosed.test(text)) return 'LOGIN_WINDOW_CLOSED';
  if (errorPatterns.credentialsRejected.test(text)) return 'CREDENTIALS_REJECTED';
  if (errorPatterns.totpRejected.test(text)) return 'TOTP_REJECTED';
  return 'UNKNOWN';
}
