import type { BrowserContext, Locator, Page } from 'playwright';
import { safeScreenshot } from './diagnose.js';
import { redact } from './secrets.js';

/**
 * Notices, announcements and modals that AlgoTest and the broker pages sometimes put in front
 * of the page. A button that is covered fails its click with a timeout, and a login form that
 * only appears once a notice is closed never shows up at all - which is how Finvasia kept
 * failing ("finvasia-await-login-page", "open-my-brokers-tab").
 *
 * This only ever clicks an explicit *close* control inside an overlay. It deliberately does
 * not press Escape and does not treat "Cancel" as a close: on a broker's consent screen
 * either of those could refuse the login.
 */

/** Containers that hold a notice. Hidden ones never match: Playwright only acts on visible elements. */
const OVERLAY = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  'dialog[open]',
  '.modal.show',
  '.modal.in',
  '.swal2-container',
  '.ReactModal__Overlay',
  '.MuiDialog-root',
  '.ant-modal-wrap',
  '.Toastify__toast',
  '.toast.show',
  '[class*="popup" i]',
  '[class*="announcement" i]',
  '[class*="notification" i]',
].join(', ');

/** Button text that means "dismiss this notice". Never "Login", "Authorize", "Submit" or "Cancel". */
export const CLOSE_NAME =
  /^\s*(close|dismiss|got it|ok|okay|later|not now|skip|no,? thanks|maybe later|×|✕|✖|x)\s*$/i;

/** The close controls inside any overlay on `page`. */
export function overlayClose(page: Page): Locator {
  const overlay = page.locator(OVERLAY);
  return overlay
    .getByRole('button', { name: CLOSE_NAME })
    .or(
      overlay.locator(
        [
          '[aria-label*="close" i]',
          'button.close',
          '.btn-close',
          'button.swal2-close',
          '[data-dismiss]',
          '[data-bs-dismiss]',
        ].join(', '),
      ),
    )
    .or(overlay.getByText(/^\s*[×✕✖]\s*$/));
}

function snippet(text: string): string {
  return redact(text.replace(/\s+/g, ' ').trim()).slice(0, 100);
}

/** Closes every notice currently showing on `page` and returns how many it closed. */
export async function dismissOverlays(
  page: Page,
  log: (m: string) => void = console.log,
): Promise<number> {
  let closed = 0;
  for (let i = 0; i < 4; i += 1) {
    const button = overlayClose(page).first();
    if (!(await button.isVisible().catch(() => false))) break;
    // Keep a picture of what it was: next time it fails we will know exactly what covered the page.
    await safeScreenshot(page, 'notice-before-dismiss');
    const text = await page
      .locator(OVERLAY)
      .first()
      .innerText({ timeout: 1_000 })
      .catch(() => '');
    log(`  closing a notice on ${new URL(page.url()).hostname}: "${snippet(text)}"`);
    await button
      .click({ timeout: 3_000 })
      .catch(() => button.click({ force: true, timeout: 1_000 }).catch(() => undefined));
    closed += 1;
    await page.waitForTimeout(300);
  }
  return closed;
}

/**
 * Waits until `target` is visible, closing any notice that is in the way. A notice can hide the
 * thing we are waiting for, or the page may not render it until the notice is closed.
 */
export async function waitVisibleDismissing(
  page: Page,
  target: Locator,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await target.isVisible().catch(() => false)) return;
    if ((await dismissOverlays(page)) > 0) continue;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(500);
  }
  // One last, short wait so the failure carries Playwright's usual message and call log.
  await target.waitFor({ state: 'visible', timeout: 1_000 });
}

/**
 * Closes notices automatically on every page of the context, including the broker's popup: while
 * any click/fill is waiting on a covered element, Playwright runs this first and then retries.
 */
export function installOverlayHandlers(context: BrowserContext): void {
  const attach = (page: Page) => {
    void page
      .addLocatorHandler(
        overlayClose(page).first(),
        async (button) => {
          console.log(`  closing a notice on ${new URL(page.url()).hostname}`);
          await button.click({ timeout: 3_000 }).catch(() => undefined);
        },
        { times: 20 },
      )
      .catch(() => undefined);
  };
  for (const page of context.pages()) attach(page);
  context.on('page', attach);
}
