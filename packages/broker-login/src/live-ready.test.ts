import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright';
import { isDeploymentsAnswer, openLive } from './live-ready.js';

/**
 * Real Chromium against a stand-in /live that draws "0 Deployed" first and the real count only
 * once its deployments call answers, as AlgoTest's page does. Skipped where no browser is installed.
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

const ORIGIN = 'https://stand-in.test';
const HTML = `<p id="count">0 Deployed</p>
<script>
  fetch('/api/execution/v2/executions?environment=live&is_signal=false')
    .then((r) => r.json())
    .then((rows) => { document.getElementById('count').textContent = rows.length + ' Deployed'; });
</script>`;

async function standIn(answer: { delayMs: number; status: number }): Promise<Page> {
  assert.ok(browser);
  const page = await (await browser.newContext()).newPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    if (!route.request().url().includes('/execution/'))
      return route.fulfill({ contentType: 'text/html', body: HTML });
    await new Promise((r) => setTimeout(r, answer.delayMs));
    return route.fulfill({
      status: answer.status,
      contentType: 'application/json',
      body: '[{},{}]',
    });
  });
  return page;
}

describe('openLive', () => {
  it('returns only after the deployments have been drawn', async (t) => {
    if (skip) return t.skip(skip);
    const page = await standIn({ delayMs: 700, status: 200 });
    await openLive(page, `${ORIGIN}/live`, 10_000);
    assert.equal(await page.locator('#count').innerText(), '2 Deployed');
    await page.context().close();
  });

  it('throws when the deployments never load', async (t) => {
    if (skip) return t.skip(skip);
    const page = await standIn({ delayMs: 0, status: 500 });
    await assert.rejects(openLive(page, `${ORIGIN}/live`, 1_500), /Timeout/);
    await page.context().close();
  });
});

describe('isDeploymentsAnswer', () => {
  const answer = (url: string, ok = true) => ({ url: () => url, ok: () => ok });

  it('is the live deployments call alone', () => {
    const base = 'https://algotest.in/api/execution/v2';
    assert.ok(isDeploymentsAnswer(answer(`${base}/executions?environment=live&is_signal=false`)));
    assert.ok(!isDeploymentsAnswer(answer(`${base}/executions?environment=forward`)));
    assert.ok(!isDeploymentsAnswer(answer(`${base}/exited-executions?environment=live`)));
    assert.ok(!isDeploymentsAnswer(answer(`${base}/executions?environment=live`, false)));
  });
});
