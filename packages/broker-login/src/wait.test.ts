import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Browser, chromium } from 'playwright';
import { visibleWithin } from './wait.js';

/**
 * Real Chromium: a button the page draws a moment after it loads, which is what AlgoTest's
 * builder does after `goto` (2026-10-19: "Import .algtst" was there, `isVisible` said no, the
 * upload then waited for a "New Strategy" button that a fresh builder does not have).
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

const LATE_BUTTON = `<body><script>
  setTimeout(() => {
    const b = document.createElement('button');
    b.textContent = 'Import .algtst';
    document.body.append(b);
  }, 1500);
</script></body>`;

describe('visibleWithin', () => {
  it('waits for an element the page draws after loading, where isVisible does not', async (t) => {
    if (skip) return t.skip(skip);
    assert.ok(browser);
    const page = await (await browser.newContext()).newPage();
    await page.setContent(LATE_BUTTON);
    const button = page.getByText('Import .algtst');
    assert.equal(await button.isVisible(), false); // the old check: answers at once
    assert.equal(await visibleWithin(button, 3_000), true);
    await page.context().close();
  });

  it('throws, rather than answering false, when the locator matches two elements', async (t) => {
    if (skip) return t.skip(skip);
    assert.ok(browser);
    const page = await (await browser.newContext()).newPage();
    await page.setContent(
      '<body><button>Import .algtst</button><button>Import .algtst</button></body>',
    );
    await assert.rejects(visibleWithin(page.getByText('Import .algtst'), 1_000), /strict mode/);
    assert.equal(await visibleWithin(page.getByText('Import .algtst').first(), 1_000), true);
    await page.context().close();
  });

  it('is false, without throwing, when the element never shows', async (t) => {
    if (skip) return t.skip(skip);
    assert.ok(browser);
    const page = await (await browser.newContext()).newPage();
    await page.setContent('<body><p>nothing here</p></body>');
    const started = Date.now();
    assert.equal(await visibleWithin(page.getByText('New Strategy'), 300), false);
    assert.ok(Date.now() - started >= 250);
    await page.context().close();
  });
});
