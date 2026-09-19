import { createInterface } from 'node:readline/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';

/**
 * One-off discovery harness. Opens a real browser, you log in by hand, and it captures
 * labelled HTML + screenshot snapshots plus a redacted HAR of the API traffic.
 *
 * Nothing here is used by the scheduled run - this exists purely so the provisional
 * locators in src/selectors.ts can be replaced with ones matching the real DOM.
 */

const OUT_DIR = '_rec';
const HAR_RAW = `${OUT_DIR}/flow.raw.har`;
const HAR_SAFE = `${OUT_DIR}/flow.redacted.har`;

const SENSITIVE_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'x-csrf-token-access',
  'x-csrf-token',
  'x-xsrf-token',
]);

async function redactHar(): Promise<number> {
  const har = JSON.parse(await readFile(HAR_RAW, 'utf8')) as {
    log: { entries: Array<Record<string, any>> };
  };

  for (const entry of har.log.entries) {
    for (const message of [entry.request, entry.response]) {
      if (!message) continue;
      if (Array.isArray(message.headers)) {
        for (const header of message.headers) {
          if (SENSITIVE_HEADERS.has(String(header.name).toLowerCase())) {
            header.value = '***REDACTED***';
          }
        }
      }
      message.cookies = [];
    }
    // Request bodies carry the password and TOTP in plain text.
    if (entry.request?.postData) {
      entry.request.postData = { mimeType: entry.request.postData.mimeType, text: '***REDACTED***' };
    }
  }

  await writeFile(HAR_SAFE, JSON.stringify(har, null, 1), 'utf8');
  return har.log.entries.length;
}

async function snapshot(page: Page, label: string): Promise<void> {
  const name = `${OUT_DIR}/${label}`;
  await writeFile(`${name}.html`, await page.content(), 'utf8');
  await page.screenshot({ path: `${name}.png`, fullPage: true });
  console.log(`  saved ${name}.html + .png  (url: ${page.url()})`);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    recordHar: { path: HAR_RAW, content: 'omit', mode: 'full' },
  });

  const pages: Page[] = [];
  const track = (page: Page): void => {
    pages.push(page);
    page.on('close', () => {
      const index = pages.indexOf(page);
      if (index >= 0) pages.splice(index, 1);
    });
    page.on('popup', (popup) => {
      console.log(`\n>> POPUP opened: ${popup.url()}`);
      console.log('>> Note this: Angel One uses a POPUP, not a same-tab redirect.');
      track(popup);
    });
  };

  context.on('request', (request) => {
    const url = request.url();
    if (url.includes('api.algotest.in')) {
      console.log(`  [api] ${request.method()} ${url.replace('https://api.algotest.in', '')}`);
    }
  });

  const first = await context.newPage();
  track(first);
  await first.goto('https://algotest.in/login');

  console.log(`
=========================================================
  AlgoTest flow recorder
=========================================================
Do the whole login by hand in the browser window:

  1. Log in at /login
  2. Go to /broker and click the "My Brokers" tab
  3. Log in Finvasia/Shoonya (inline password + TOTP form)
  4. Log in Angel One (watch for a redirect or a popup)

Press ENTER here at each interesting state to capture a
snapshot. Capture at least these four:

  1. the login form
  2. My Brokers list while both brokers are logged OUT
  3. the Shoonya password/TOTP form, open and empty
  4. the broker list right after Angel One returns

Type q then ENTER when you are done.
=========================================================
`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let index = 0;

  for (;;) {
    const answer = (await rl.question('[ENTER] snapshot, [q] finish > ')).trim().toLowerCase();
    if (answer === 'q') break;

    const page = pages[pages.length - 1];
    if (!page) {
      console.log('  no open page to capture');
      continue;
    }
    index += 1;
    await snapshot(page, `snap-${String(index).padStart(2, '0')}`).catch((error) =>
      console.error('  snapshot failed:', error instanceof Error ? error.message : error),
    );
  }

  rl.close();
  await context.close();
  await browser.close();

  const count = await redactHar();
  console.log(`
Done. In ${OUT_DIR}/:
  snap-*.html / snap-*.png   ${index} snapshot(s)
  flow.redacted.har          ${count} requests, safe to share
  flow.raw.har               UNREDACTED - delete this

Next: share the snap-* files and flow.redacted.har, and say whether
Angel One opened in the same tab or a popup.
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
