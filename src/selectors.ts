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

export const brokerPage = {
  /** PROVISIONAL - bundle confirms the literal string "My Brokers" */
  myBrokersTab: (page: Page): Locator =>
    page
      .getByRole('tab', { name: /my brokers/i })
      .or(page.getByRole('button', { name: /my brokers/i }))
      .or(page.getByRole('link', { name: /my brokers/i }))
      .or(page.getByText(/^\s*My Brokers\s*$/))
      .first(),

  /**
   * A broker's row/card, found relationally rather than structurally: the smallest
   * element that mentions the broker AND carries a Login/Logout control. `.last()`
   * picks the innermost match, avoiding the "whole page contains the text" trap.
   */
  card: (page: Page, broker: RegExp): Locator =>
    page
      .locator('div, tr, li')
      .filter({ hasText: broker })
      .filter({ has: page.getByText(/^\s*(Login|Logout)\s*$/) })
      .last(),

  loginButton: (card: Locator): Locator =>
    card.getByRole('button', { name: /^\s*login\s*$/i }).first(),

  /** Presence of a Logout control is our proof that the broker is logged in. */
  logoutButton: (card: Locator): Locator =>
    card.getByRole('button', { name: /^\s*logout\s*$/i }).first(),
};

/** Inline form AlgoTest shows for Shoonya: password + rotating TOTP. PROVISIONAL */
export const shoonyaForm = {
  password: (page: Page): Locator =>
    page
      .getByLabel(/password/i)
      .or(page.getByPlaceholder(/password/i))
      .or(page.locator('input[type="password"]'))
      .first(),

  totp: (page: Page): Locator =>
    page
      .getByLabel(/totp|otp|authenticator/i)
      .or(page.getByPlaceholder(/totp|otp/i))
      .first(),

  submit: (page: Page): Locator =>
    page.getByRole('button', { name: /^\s*(login|submit|verify)\s*$/i }).first(),
};

/** Angel One's own login page, reached by redirect. PROVISIONAL */
export const angelOneForm = {
  clientCode: (page: Page): Locator =>
    page
      .getByLabel(/client ?code|user ?id/i)
      .or(page.getByPlaceholder(/client ?code|user ?id/i))
      .first(),

  mpin: (page: Page): Locator =>
    page
      .getByLabel(/m?pin|password/i)
      .or(page.getByPlaceholder(/m?pin|password/i))
      .or(page.locator('input[type="password"]'))
      .first(),

  totp: (page: Page): Locator =>
    page
      .getByLabel(/totp|otp|authenticator/i)
      .or(page.getByPlaceholder(/totp|otp/i))
      .first(),

  submit: (page: Page): Locator =>
    page.getByRole('button', { name: /^\s*(login|submit|continue|verify)\s*$/i }).first(),
};

/** Matched against error text to decide whether a retry is safe. */
export const errorPatterns = {
  totpRejected: /invalid\s*(totp|otp)|totp.*(invalid|incorrect|expired)|otp.*(invalid|incorrect|expired)/i,
  credentialsRejected:
    /invalid\s*(password|pin|mpin|credential|user)|incorrect\s*(password|pin|mpin)|blocked|locked|too many/i,
  loginWindowClosed: /login.*(not allowed|window|timing)|allowed between|08:30|3:28/i,
};

export const brokerNames = {
  angelone: /angel\s*one/i,
  shoonya: /shoonya|finvasia/i,
};
