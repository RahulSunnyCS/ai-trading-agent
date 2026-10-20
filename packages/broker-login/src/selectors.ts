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
  myBrokersTab: (page: Page): Locator => page.getByRole('button', { name: /my brokers/i }).first(),

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
export const finvasiaForm = {
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
    page
      .locator('label.login-option')
      .filter({ hasText: /^\s*TOTP\s*$/ })
      .first(),

  /** The page holds hidden duplicates for the other modes - only the visible one counts. */
  clientCode: (page: Page): Locator =>
    page.locator('input[placeholder="Enter your Client ID"]:visible').first(),

  mpin: (page: Page): Locator => page.locator('#tot-pin'),

  totp: (page: Page): Locator => page.locator('#tot-totp'),

  submit: (page: Page): Locator => page.locator('#totp-login'),

  error: (page: Page): Locator => page.locator('#login-error'),
};

/**
 * Quantiply (Angel One's algo platform), used by src/quantiply.ts. Its login screen
 * (app.quantiply.angelone.in/auth?resume=/algos) shows one "Login / Sign Up" button, which
 * navigates to Angel's SmartAPI publisher login ("Login to Quantiply") - the same page as
 * AlgoTest's Angel One login, so the verified `angelOneForm` locators above fill it.
 *
 * Confirmed by a real headed login on 2026-10-18 (auth -> SmartAPI publisher login -> /algos in
 * 11 s). If a step fails after a redesign, the run's diagnostics artifact holds a screenshot
 * (inputs blanked) and redacted HTML named after the step (`fail-quantiply-...`); fix it from that.
 */
export const quantiplyPage = {
  /** The single button on the /auth screen. Also the logged-OUT marker after the round trip. */
  loginButton: (page: Page): Locator =>
    page
      .getByRole('button', { name: /log\s*in\s*\/\s*sign\s*up/i })
      .or(page.getByRole('link', { name: /log\s*in\s*\/\s*sign\s*up/i }))
      .first(),
};

/** Matched against error text to decide whether a retry is safe. */
export const errorPatterns = {
  totpRejected:
    /invalid\s*(totp|otp)|totp.*(invalid|incorrect|expired)|otp.*(invalid|incorrect|expired)/i,
  credentialsRejected:
    /invalid\s*(password|pin|mpin|credential|user)|incorrect\s*(password|pin|mpin)|blocked|locked|too many/i,
  loginWindowClosed:
    /only possible between|trading days|login.*(not allowed|window|timing)|allowed between|08:15|15:40/i,
};

export const brokerNames = {
  angelone: /angel\s*one/i,
  // The regex still matches "Shoonya" — AlgoTest's own UI copy used that name
  // for a while and a stale session/cached page could still show it; only the
  // object key (the internal identifier) changed to `finvasia`.
  finvasia: /shoonya|finvasia/i,
};

/** The `Broker.<Name>` fragment inside each broker's data-broker attribute. */
export const dataBrokerKeys = {
  angelone: 'AngelOne',
  finvasia: 'Finvasia',
};

/**
 * Fyers' own OAuth login (api-t1.fyers.in/api/v3/generate-authcode -> login.fyers.in),
 * used by src/fyers.ts to mint a data token for the weekly momentum job.
 *
 * PROVISIONAL - written without a recording. The flow is: client ID -> 6-digit TOTP
 * -> 4-digit PIN -> (first time only) authorise the app -> redirect with auth_code.
 * The OTP and PIN are rows of single-character boxes that auto-advance, so they are
 * typed into the first visible box rather than filled one by one. If a step fails,
 * the run's diagnostics artifact holds a screenshot (inputs blanked) and redacted HTML
 * of the page - tighten these from that.
 */
export const fyersLogin = {
  /**
   * The page opens on the "Mobile number" radio; `#clientId_rb` ("Client ID", confirmed from
   * the 2026-10-10 diagnostics HTML) swaps in the client ID form. The text form is an older layout.
   */
  useClientId: (page: Page): Locator =>
    page
      .locator('label:has(input#clientId_rb)')
      .or(page.getByText(/(login|continue) (with|using) client id/i))
      .first(),

  clientId: (page: Page): Locator =>
    page
      .locator('input#fy_client_id:visible')
      .or(page.getByPlaceholder(/client id/i).locator('visible=true'))
      .first(),

  submit: (page: Page): Locator =>
    page.getByRole('button', { name: /^(continue|proceed|next|verify|submit|login)\b/i }).first(),

  /** The first box of the TOTP or PIN row currently on screen. */
  firstDigitBox: (page: Page): Locator =>
    page.locator('input[maxlength="1"]:visible, input[inputmode="numeric"]:visible').first(),

  /** Headings that tell the TOTP step and the PIN step apart. */
  totpStep: (page: Page): Locator =>
    page.getByText(/(enter|verify).*(totp|authenticator|otp)/i).first(),
  pinStep: (page: Page): Locator => page.getByText(/(enter|verify).*pin/i).first(),

  /** First-time consent for the API app. */
  authorize: (page: Page): Locator =>
    page.getByRole('button', { name: /authori[sz]e|allow|accept/i }).first(),

  error: (page: Page): Locator =>
    page
      .getByText(/invalid|incorrect|wrong|expired|blocked|locked|too many attempts/i)
      .locator('visible=true')
      .first(),
};

/**
 * BL-137: the strategy builder (/backtest) at desktop width (1440 x 900; below about 500 px AlgoTest
 * switches to a phone layout without "Save Strategy"). VERIFIED 2026-10-19 by importing and saving
 * four strategies in the owner's session: the hidden file input, "Strategy imported successfully",
 * "Save Strategy" → "Save New Strategy" (name pre-filled) → "Done" → "Strategy Saved", "Export .algtst".
 * Deleting does not click: `strategy-delete.ts` calls AlgoTest's API by the strategy's id (saved
 * strategies outside a folder are not listed in the sidebar at all, 2026-10-20).
 */
export const strategyPage = {
  importInput: (page: Page): Locator => page.locator('input[type=file][accept*=".algtst"]'),
  importButton: (page: Page): Locator => page.getByText('Import .algtst').first(),
  newStrategy: (page: Page): Locator => page.getByText('New Strategy').first(),
  title: (page: Page, name: string): Locator => page.getByText(name, { exact: true }).first(),
  saveButton: (page: Page): Locator => page.getByRole('button', { name: /Save Strategy/ }),
  saveDialog: (page: Page): Locator => page.getByText('Save New Strategy'),
  saveName: (page: Page): Locator =>
    page.getByText('Strategy Name:').locator('xpath=following::input[1]'),
  saveDone: (page: Page): Locator => page.getByRole('button', { name: 'Done', exact: true }),
  savedToast: (page: Page): Locator => page.getByText('Strategy Saved'),
  exportButton: (page: Page): Locator => page.getByText('Export .algtst'),
};

/**
 * BL-138: Algo Trade (/live). VERIFIED 2026-10-19 from the owner's session: the Activation rows
 * (select a row by its name, then "Setup Execution" / "Edit Execution" and "Activate"), and the
 * "Edit execution for <name>" sheet (Quantity Multiplier, per-leg NRML/MIS selects, Weekdays/DTE
 * day boxes, "Setup Execution Settings"). What "Activate" opens is NOT yet seen.
 */
export const livePage = {
  header: (page: Page): Locator => page.getByText('Strategy Deployed').first(),
  anyRowCount: (page: Page): Locator => page.getByText(/^\d+ Deployed$/).first(),
  row: (page: Page, name: string): Locator => page.getByText(name, { exact: true }).first(),
  setupExecution: (page: Page): Locator =>
    page.getByRole('button', { name: /^(Setup|Edit) Execution$/ }).first(),
  activate: (page: Page): Locator =>
    page.getByRole('button', { name: 'Activate', exact: true }).filter({ visible: true }).first(),
  /** The sheet: the innermost element holding its title and its save button. */
  sheet: (page: Page, name: string): Locator =>
    page
      .locator('div')
      .filter({ has: page.getByText(`Edit execution for ${name}`) })
      .filter({ has: page.getByRole('button', { name: 'Setup Execution Settings' }) })
      .last(),
  sheetSave: (sheet: Locator): Locator =>
    sheet.getByRole('button', { name: 'Setup Execution Settings' }),
  /** Anything that may open after "Activate": a dialog or a bottom sheet. */
  popup: (page: Page): Locator =>
    page
      .locator('[role=dialog], [role=alertdialog], [class*="fixed bottom-0"][class*="flex-col"]')
      .filter({ visible: true }),
};
