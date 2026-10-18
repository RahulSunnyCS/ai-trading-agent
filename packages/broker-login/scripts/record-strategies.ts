import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { type Page, chromium } from 'playwright';
import { algotestLogin } from '../src/algotest.js';
import { normalizePhone } from '../src/config.js';
import { registerSecret } from '../src/secrets.js';

/**
 * BL-137 Phase 2 / BL-138 Phase 1 discovery: how AlgoTest imports, saves, lists, deploys (Forward
 * Test only), stops and deletes a strategy. The owner runs it; it logs in with the same
 * `algotestLogin` the 08:00 job uses, then the owner clicks each step by hand in the window while
 * this records a snapshot per step and the API traffic. Nothing here clicks anything after login.
 *
 *   ENV_FILE=<path to .env> node_modules/.bin/tsx scripts/record-strategies.ts [file.algtst]
 *
 * Output in _rec/strategies-<time>/ (git-ignored): one HTML + PNG per step, steps.json (each
 * step's time and the API calls made since the previous one), and api.redacted.har. The raw HAR
 * is deleted after redaction: cookies, auth and CSRF headers, and any password / token / OTP field
 * in a JSON body or URL are masked, and the login request's body is dropped whole.
 */

const STEPS = [
  'Backtest page open, nothing imported yet',
  'Import the .algtst file (the import button, choose the file); stop when the strategy shows',
  'Save it as a strategy (any name starting "T1 · TEST"); stop when saved',
  'Open the list of saved strategies with it in view',
  'Deploy it to FORWARD TEST (paper) only, 1 lot; stop when it shows as deployed',
  'Stop / undeploy it; stop when it shows as stopped',
  'Delete the saved strategy; stop when it is gone',
] as const;

const SENSITIVE_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'x-csrf-token-access',
  'x-csrf-token',
  'x-xsrf-token',
]);
const SENSITIVE_KEYS = /pass|token|otp|totp|pin|secret|session|phone|mobile|email|api_?key/i;

function maskJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEYS.test(k) ? '***' : maskJson(v)]),
    );
  }
  return value;
}

function maskText(text: string): string {
  try {
    return JSON.stringify(maskJson(JSON.parse(text)));
  } catch {
    return text.length > 20_000 ? `${text.slice(0, 20_000)}…(cut)` : text;
  }
}

function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEYS.test(key)) url.searchParams.set(key, '***');
    }
    return url.toString();
  } catch {
    return raw;
  }
}

async function redactHar(raw: string, safe: string): Promise<number> {
  // Playwright's HAR is third-party JSON; this one-off discovery script does not type it.
  const har = JSON.parse(await readFile(raw, 'utf8')) as {
    // biome-ignore lint/suspicious/noExplicitAny: untyped third-party HAR payload
    log: { entries: Array<Record<string, any>> };
  };
  har.log.entries = har.log.entries.filter((e) => String(e.request?.url).includes('algotest.in'));
  for (const entry of har.log.entries) {
    entry.request.url = maskUrl(entry.request.url);
    for (const message of [entry.request, entry.response]) {
      if (!message) continue;
      for (const header of message.headers ?? []) {
        if (SENSITIVE_HEADERS.has(String(header.name).toLowerCase())) header.value = '***';
      }
      message.cookies = [];
    }
    const isLogin = /\/login\b/i.test(entry.request.url);
    if (entry.request.postData) {
      entry.request.postData = {
        mimeType: entry.request.postData.mimeType,
        text: isLogin ? '***' : maskText(String(entry.request.postData.text ?? '')),
      };
    }
    const content = entry.response?.content;
    if (content?.text) {
      content.text =
        isLogin || content.encoding === 'base64' ? '***' : maskText(String(content.text));
    }
  }
  await writeFile(safe, JSON.stringify(har, null, 1), 'utf8');
  return har.log.entries.length;
}

async function snapshot(page: Page, dir: string, label: string): Promise<void> {
  await writeFile(`${dir}/${label}.html`, await page.content(), 'utf8');
  await page.screenshot({ path: `${dir}/${label}.png`, fullPage: true });
}

async function main(): Promise<void> {
  const envFile = process.env.ENV_FILE ?? '.env';
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const rawPhone = process.env.ALGOTEST_PHONE?.trim();
  const password = process.env.ALGOTEST_PASSWORD?.trim();
  if (!rawPhone || !password) {
    console.error(`ALGOTEST_PHONE / ALGOTEST_PASSWORD not found (read ${envFile}); set ENV_FILE.`);
    process.exit(1);
  }
  registerSecret(password);
  const phone = normalizePhone(rawPhone);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = `_rec/strategies-${stamp}`;
  await mkdir(dir, { recursive: true });
  const harRaw = `${dir}/api.raw.har`;

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    recordHar: { path: harRaw, content: 'embed', mode: 'full', urlFilter: /algotest\.in/ },
  });

  let calls: string[] = [];
  context.on('request', (request) => {
    const url = request.url();
    if (!url.includes('api.algotest.in')) return;
    const line = `${request.method()} ${maskUrl(url).replace(/^https:\/\/api\.algotest\.in/, '')}`;
    calls.push(line);
    console.log(`  [api] ${line}`);
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const steps: Array<{ step: number; what: string; at: string; calls: string[] }> = [];

  try {
    await algotestLogin(page, { phone, password });
    console.log('AlgoTest login: OK');
    await page.goto('https://algotest.in/backtest', { waitUntil: 'domcontentloaded' });

    const file = process.argv[2];
    console.log(`
=========================================================
  AlgoTest strategy flow recorder (BL-137 / BL-138)
=========================================================
Do each step by hand in the browser window, then press
ENTER here. Forward Test (paper) only: never deploy live.
${file ? `File to import: ${file}\n` : ''}Type q then ENTER to stop early.
=========================================================`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (const [index, what] of STEPS.entries()) {
      const n = index + 1;
      const answer = (await rl.question(`\nStep ${n}/${STEPS.length}: ${what}\n[ENTER] done > `))
        .trim()
        .toLowerCase();
      if (answer === 'q') break;
      const label = `step-${String(n).padStart(2, '0')}`;
      await snapshot(page.context().pages().at(-1) ?? page, dir, label).catch((error) =>
        console.error('  snapshot failed:', error instanceof Error ? error.message : error),
      );
      steps.push({ step: n, what, at: new Date().toISOString(), calls });
      console.log(`  saved ${label} (${calls.length} API call(s) since the last step)`);
      calls = [];
    }
    rl.close();
  } finally {
    await writeFile(`${dir}/steps.json`, JSON.stringify(steps, null, 2), 'utf8');
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  if (existsSync(harRaw)) {
    const count = await redactHar(harRaw, `${dir}/api.redacted.har`);
    await rm(harRaw);
    console.log(`\nDone: ${steps.length} step(s), ${count} AlgoTest request(s) in ${dir}/`);
  }
  console.log('Tell Claude the folder name. The raw HAR has been deleted.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
