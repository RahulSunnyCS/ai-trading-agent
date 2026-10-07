import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright';
import {
  CLOSE_NAME,
  dismissOverlays,
  installOverlayHandlers,
  waitVisibleDismissing,
} from './overlays.js';

/**
 * Real Chromium against small HTML pages: a covering notice, a form that only exists once the
 * notice is closed, and a consent dialog that must be left alone. Skipped where no browser is
 * installed (the broker-login CI runs in the Playwright image, where one is).
 */
let browser: Browser | null = null;
let skip: string | false = false;

before(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    skip = `no Chromium available: ${error instanceof Error ? error.message.split('\n')[0] : error}`;
  }
});
after(async () => {
  await browser?.close();
});

async function page(html: string): Promise<Page> {
  assert.ok(browser);
  const p = await (await browser.newContext()).newPage();
  p.setDefaultTimeout(3_000);
  await p.setContent(html);
  return p;
}

const SILENT = () => undefined;

const NOTICE_OVER_BUTTON = `
  <button id="go" onclick="document.title='clicked'">Login</button>
  <div role="dialog" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10">
    <p>Scheduled maintenance tonight</p>
    <button onclick="this.closest('[role=dialog]').remove()">Got it</button>
  </div>`;

describe('close-button names', () => {
  it('match dismiss wording but never Login, Authorize, Submit or Cancel', () => {
    for (const ok of ['Close', 'Got it', 'OK', 'Skip', 'Not now', '×', 'x']) {
      assert.match(ok, CLOSE_NAME);
    }
    for (const no of ['Login', 'Authorize', 'Submit', 'Cancel', 'Allow', 'Accept']) {
      assert.doesNotMatch(no, CLOSE_NAME);
    }
  });
});

describe('overlays', () => {
  it('dismissOverlays closes a notice that covers the page', async (t) => {
    if (skip) return t.skip(skip);
    const p = await page(NOTICE_OVER_BUTTON);
    assert.equal(await dismissOverlays(p, SILENT), 1);
    assert.equal(await p.locator('[role=dialog]').count(), 0);
  });

  it('a covered click succeeds because the handler closes the notice first', async (t) => {
    if (skip) return t.skip(skip);
    const p = await page(NOTICE_OVER_BUTTON);
    installOverlayHandlers(p.context());
    await p.locator('#go').click();
    assert.equal(await p.title(), 'clicked');
  });

  it('waits for a form that only appears once the notice is closed', async (t) => {
    if (skip) return t.skip(skip);
    const p = await page(`
      <div class="modal show" style="display:block">
        <button class="btn-close" aria-label="Close" onclick="
          this.closest('.modal').remove(); document.getElementById('form').hidden = false"></button>
        Important update
      </div>
      <form id="form" hidden><input id="lgnusrid"></form>`);
    await waitVisibleDismissing(p, p.locator('#lgnusrid'), 5_000);
    assert.equal(await p.locator('#lgnusrid').isVisible(), true);
  });

  it('leaves a consent dialog alone (Authorize / Cancel are not close buttons)', async (t) => {
    if (skip) return t.skip(skip);
    const p = await page(`
      <div role="dialog"><button>Authorize</button><button>Cancel</button></div>`);
    assert.equal(await dismissOverlays(p, SILENT), 0);
    assert.equal(await p.locator('[role=dialog]').count(), 1);
  });

  it('does nothing on a page with no notice', async (t) => {
    if (skip) return t.skip(skip);
    const p = await page('<button>Login</button>');
    assert.equal(await dismissOverlays(p, SILENT), 0);
  });
});
