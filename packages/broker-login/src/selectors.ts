import type { Locator, Page } from 'playwright';

/**
 * Every locator in the project lives here, so a redesign on AlgoTest's side is a
 * single-file fix. Prefer role/label/placeholder over CSS, and never use Tailwind or
 * Next.js hashed class names - those change on every deploy.
 *
 * Locators marked PROVISIONAL are best guesses written before the flow was recorded
 * against a real logged-in session. Tighten them once the recording exists.
 */

/**
 * VERIFIED against the live page on 2026-09-18. AlgoTest logs in with a +91 phone
 * number and password - there is no email field. The form carries stable `name`
 * attributes and an id, so these need no guesswork.
 *
 * <form id="loginFormID">
 *   <span>+91</span><input name="phone" placeholder="Phone Number" type="text">
 *   <input name="password" type="password">
 *   <button type="submit">Login</button>
 */
export const loginPage = {
  form: (page: Page): Locator => page.locator('#loginFormID'),

  /** Only the 10 digits - the +91 prefix is static text outside the input. */
  phone: (page: Page): Locator => page.locator('#loginFormID input[name="phone"]'),

  password: (page: Page): Locator => page.locator('#loginFormID input[name="password"]'),

  submit: (page: Page): Locator => page.locator('#loginFormID button[type="submit"]'),

  /** Rendered in an aria-live notifications region, not inside the form. */
  error: (page: Page): Locator =>
    page
      .locator('[aria-live="polite"]')
      .getByText(/invalid|incorrect|wrong|not registered|does not match|failed/i)
      .first()
      .or(page.getByText(/invalid (phone|password|credentials)|incorrect password/i).first()),
};

/**
 * VERIFIED against a real My Brokers (2) session on 2026-09-18, in both a logged-in
 * state (during market hours) and a logged-out state (outside the 08:15-15:40 IST
 * broker login window). Findings that shaped the design:
 *
 * 1. The tab is a plain <button>My Brokers (2)</button>, not an ARIA tab/link.
 * 2. During the login window, each card's action button carries a stable,
 *    purpose-built identifier:
 *      <button data-broker="angelone_Broker.AngelOne_<accountId>">Re-login</button>
 *    "Logout" never carries this attribute (and is disabled while logged in). This
 *    is a far more reliable click target than matching on button label text, which
 *    switches between "Login" (never-logged-in-today) and "Re-login" (has a session,
 *    possibly stale) - both trigger the same login flow.
 * 3. OUTSIDE the login window, AlgoTest replaces the action button entirely with a
 *    disabled "Market Closed" placeholder that carries NO data-broker attribute at
 *    all - confirmed empty on a live capture. So `card` (used to read status at any
 *    time, including diagnostics) must not depend on data-broker existing; only
 *    `actionButton` (used solely to click, which only makes sense inside the window
 *    anyway) does.
 */
export const brokerPage = {
  myBrokersTab: (page: Page): Locator =>
    page.getByRole('button', { name: /my brokers/i }).first(),

  /**
   * The broker's card, found relationally: the smallest element that mentions the
   * broker's display name (e.g. "Angel One - Rahul") and also has a "Status" label -
   * present in every state, unlike the action button. `.last()` picks the innermost
   * match, avoiding the "whole page contains the text" trap.
   */
  card: (page: Page, broker: RegExp): Locator =>
    page
      .locator('div')
      .filter({ hasText: broker })
      .filter({ has: page.getByText('Status', { exact: true }) })
      .last(),

  /**
   * The Login / Re-login button - both states use this same attribute, so no
   * assumption is made about which label is currently showing. Only present during
   * the 08:15-15:40 IST login window; outside it there is nothing to click.
   */
  actionButton: (page: Page, dataBrokerKey: string): Locator =>
    page.locator(`button[data-broker*="${dataBrokerKey}"]`).first(),

  /**
   * <div><p>Status</p><p class="...">Logged in</p></div> - anchored on the "Status"
   * label and its immediate sibling, not on the (redesign-prone) utility classes
   * that give the value element its green/uppercase styling.
   */
  statusText: (card: Locator): Locator =>
    card.getByText('Status', { exact: true }).locator('xpath=following-sibling::p[1]'),
};

/**
 * VERIFIED against Finvasia's OAuth login page (captured live 2026-09-19). AlgoTest's
 * docs describe an inline password + TOTP form, but the real flow redirects to
 * Finvasia's own page - the same shape as Angel One - with all three fields on one
 * screen. The ids are stable; the surrounding smart-* widgets are not worth touching.
 */
export const shoonyaForm = {
  userId: (page: Page): Locator => page.locator('#lgnusrid'),

  password: (page: Page): Locator => page.locator('#lgnpwd'),

  totp: (page: Page): Locator => page.locator('#lgnotp'),

  submit: (page: Page): Locator => page.locator('button.lgnBtnClss'),

  /**
   * OAuth consent screen ("wants to access your account"). Finvasia shows it instead of
   * the login form whenever the browser already holds a Finvasia session - seen on a
   * GitHub runner when a second attempt followed a first one that had logged in.
   */
  authorize: (page: Page): Locator => page.getByRole('button', { name: /^\s*authorize\s*$/i }),
};

/**
 * VERIFIED against Angel One's SmartAPI login page (captured live 2026-09-19), reached
 * by redirect from AlgoTest's Login/Re-login button.
 */
export const angelOneForm = {
  /**
   * The SmartAPI page defaults to Mobile Number + SMS OTP, which can't be automated.
   * Its "TOTP" radio reveals Client ID + 4-digit PIN + 6-digit TOTP instead. The
   * radio input itself is styled away, so the wrapping label is what gets clicked.
   */
  totpModeOption: (page: Page): Locator =>
    page.locator('label.login-option').filter({ hasText: /^\s*TOTP\s*$/ }).first(),

  /** The page holds hidden duplicates for the other modes - only the visible one counts. */
  clientCode: (page: Page): Locator =>
    page.locator('input[placeholder="Enter your Client ID"]:visible').first(),

  mpin: (page: Page): Locator => page.locator('#tot-pin'),

  totp: (page: Page): Locator => page.locator('#tot-totp'),

  submit: (page: Page): Locator => page.locator('#totp-login'),

  error: (page: Page): Locator => page.locator('#login-error'),
};

/** Matched against error text to decide whether a retry is safe. */
export const errorPatterns = {
  totpRejected: /invalid\s*(totp|otp)|totp.*(invalid|incorrect|expired)|otp.*(invalid|incorrect|expired)/i,
  credentialsRejected:
    /invalid\s*(password|pin|mpin|credential|user)|incorrect\s*(password|pin|mpin)|blocked|locked|too many/i,
  loginWindowClosed: /only possible between|trading days|login.*(not allowed|window|timing)|allowed between|08:15|15:40/i,
};

export const brokerNames = {
  angelone: /angel\s*one/i,
  shoonya: /shoonya|finvasia/i,
};

/** The `Broker.<Name>` fragment inside each broker's data-broker attribute. */
export const dataBrokerKeys = {
  angelone: 'AngelOne',
  shoonya: 'Finvasia',
};
