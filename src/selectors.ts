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
 * VERIFIED against a real My Brokers (2) session on 2026-09-18 (angelonelimited +
 * finvasia, both logged in). Two findings changed the design from the provisional
 * version:
 *
 * 1. The tab is a plain <button>My Brokers (2)</button>, not an ARIA tab/link.
 * 2. Each card's action button carries a stable, purpose-built identifier:
 *      <button data-broker="angelone_Broker.AngelOne_<accountId>">Re-login</button>
 *    "Logout" never carries this attribute (and is disabled while logged in). This
 *    is a far more reliable anchor than matching on button label text, which
 *    switches between "Login" (never-logged-in-today) and "Re-login" (has a session,
 *    possibly stale) - both trigger the same login flow, so we target either via the
 *    data-broker attribute rather than asserting a specific label.
 *
 * The logged-in state was confirmed end to end; the logged-out rendering (does the
 * badge/button actually reset each trading morning, or stay stale?) is inferred from
 * the user's description, not yet observed directly - see project memory.
 */
export const brokerPage = {
  myBrokersTab: (page: Page): Locator =>
    page.getByRole('button', { name: /my brokers/i }).first(),

  /**
   * The broker's card, found relationally: the smallest element that mentions the
   * broker's display name (e.g. "Angel One - Rahul") and also contains its
   * data-broker action button. `.last()` picks the innermost match.
   */
  card: (page: Page, broker: RegExp, dataBrokerKey: string): Locator =>
    page
      .locator('div')
      .filter({ hasText: broker })
      .filter({ has: page.locator(`[data-broker*="${dataBrokerKey}"]`) })
      .last(),

  /**
   * The Login / Re-login button - both states use this same attribute, so no
   * assumption is made about which label is currently showing.
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

/** The `Broker.<Name>` fragment inside each broker's data-broker attribute. */
export const dataBrokerKeys = {
  angelone: 'AngelOne',
  shoonya: 'Finvasia',
};
