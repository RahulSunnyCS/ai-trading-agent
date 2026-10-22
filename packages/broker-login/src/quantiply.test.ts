import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { runQuantiply, runQuantiplyIsolated } from './quantiply.js';
import { resetAngelTotpWindow } from './totp.js';

/**
 * The Quantiply flow in real Chromium against stand-in pages: every request is answered by the
 * route below and anything else is aborted, so nothing reaches Quantiply or Angel One and no real
 * credentials exist here. The stand-ins copy the shape seen on 2026-10-18 (one "Login / Sign Up"
 * button, a same-tab hop to Angel's SmartAPI page) and the verified angelOneForm ids. Skipped
 * where no browser is installed.
 */

// Screenshots go to ./artifacts; keep them out of the package folder.
process.chdir(mkdtempSync(join(tmpdir(), 'broker-login-quantiply-')));

const CREDS = { clientCode: 'TEST01', mpin: '0000', totpSecret: 'JBSWY3DPEHPK3PXP' };

type AngelOutcome =
  | 'success'
  | 'invalid-pin'
  | 'bounce'
  | 'popup'
  | 'already'
  | 'already-bounce'
  | 'totp-once'
  | 'hang';

const ANGEL_URL =
  'https://smartapi.angelone.in/publisher-login/v1/?api_key=k&redirect_url=https%3A%2F%2Fapi-prod.quantiply.angelone.in%2Fauth%2Fangel%2Fredirect';

function quantiplyAuth(outcome: AngelOutcome): string {
  const open = outcome === 'popup' ? `window.open('${ANGEL_URL}')` : `location.href='${ANGEL_URL}'`;
  return `<!doctype html><title>Quantiply</title><button onclick="${open}">Login / Sign Up</button>`;
}

const SHOW_ERROR = (text: string) =>
  `document.getElementById('login-error').textContent='${text}';document.getElementById('login-error').style.display='block'`;
const REDIRECT =
  "location.href='https://api-prod.quantiply.angelone.in/auth/angel/redirect?code=c'";

function angelPage(onSubmit: string): string {
  return `<!doctype html><title>Login to Quantiply</title>
    <label class="login-option">Mobile Number</label>
    <label class="login-option">Client ID</label>
    <label class="login-option" onclick="document.getElementById('form').hidden=false">TOTP</label>
    <div id="form" hidden>
      <input placeholder="Enter your Client ID"><input id="tot-pin"><input id="tot-totp">
      <button id="totp-login" onclick="${onSubmit}">Login</button>
    </div>
    <div id="login-error" style="display:none"></div>`;
}

const ALGOS = '<!doctype html><title>Algos</title><h1>My algos</h1>';
const BOUNCING_ALGOS = `<!doctype html><title>Algos</title>
  <script>setTimeout(() => location.replace('/auth?resume=/algos'), 300)</script>`;
const TO_ALGOS = "<script>location.replace('/algos')</script>";

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
beforeEach(() => resetAngelTotpWindow());

/** Answers every request from the stand-ins and aborts anything else: nothing leaves the machine. */
async function install(context: BrowserContext, outcome: AngelOutcome, hits: string[]) {
  const loads = (key: string) => hits.filter((h) => h === key).length;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const key = `${url.hostname}${url.pathname}`;
    hits.push(key);
    const html = (body: string) => route.fulfill({ contentType: 'text/html', body });
    if (key === 'app.quantiply.angelone.in/auth') {
      if (outcome === 'hang') return; // never answered
      if (outcome === 'already') return html(TO_ALGOS);
      if (outcome === 'already-bounce' && loads(key) === 1) return html(TO_ALGOS);
      return html(quantiplyAuth(outcome));
    }
    if (key === 'smartapi.angelone.in/publisher-login/v1/') {
      if (outcome === 'invalid-pin') return html(angelPage(SHOW_ERROR('Invalid PIN')));
      if (outcome === 'totp-once' && loads(key) === 1) {
        return html(angelPage(SHOW_ERROR('Invalid TOTP')));
      }
      return html(angelPage(REDIRECT));
    }
    if (key === 'api-prod.quantiply.angelone.in/auth/angel/redirect') {
      return html("<script>location.replace('https://app.quantiply.angelone.in/algos')</script>");
    }
    if (key === 'app.quantiply.angelone.in/algos') {
      const bounce = outcome === 'bounce' || (outcome === 'already-bounce' && loads(key) === 1);
      return html(bounce ? BOUNCING_ALGOS : ALGOS);
    }
    return route.abort();
  });
}

async function standIn(
  outcome: AngelOutcome,
): Promise<{ context: BrowserContext; hits: string[] }> {
  assert.ok(browser);
  const context = await browser.newContext();
  const hits: string[] = [];
  await install(context, outcome, hits);
  return { context, hits };
}

const angelLoads = (hits: string[]) =>
  hits.filter((h) => h.startsWith('smartapi.angelone.in')).length;

/** Every capture a test left: the logged-in pages must never be among them. */
function captures(): string[] {
  return existsSync('artifacts') ? readdirSync('artifacts') : [];
}

describe('Quantiply login (stand-in pages)', () => {
  it('logs in: Login / Sign Up -> Angel TOTP form -> back on /algos, with no picture of it', async (t) => {
    if (skip) return t.skip(skip);
    const before = captures();
    const { context, hits } = await standIn('success');
    const result = await runQuantiply(context, CREDS);
    assert.equal(result.status, 'OK', result.detail);
    assert.match(result.detail, /^logged in \(\d+s\)$/);
    assert.equal(angelLoads(hits), 1);
    assert.deepEqual(captures(), before, 'a successful login must save no screenshot');
    await context.close();
  });

  it('also works when Angel’s page opens in a popup', async (t) => {
    if (skip) return t.skip(skip);
    const { context } = await standIn('popup');
    const result = await runQuantiply(context, CREDS);
    assert.equal(result.status, 'OK', result.detail);
    await context.close();
  });

  it('a wrong PIN on Angel’s page fails at once and is not retried', async (t) => {
    if (skip) return t.skip(skip);
    const { context, hits } = await standIn('invalid-pin');
    const result = await runQuantiply(context, CREDS);
    assert.equal(result.status, 'FAIL');
    assert.match(result.detail, /Invalid PIN - NOT retried, check the ANGELONE_\* secrets/);
    assert.equal(angelLoads(hits), 1, 'the credentials must be sent once only');
    await context.close();
  });

  it('a refused TOTP is retried once, with a code from the next window', async (t) => {
    if (skip) return t.skip(skip);
    const { context, hits } = await standIn('totp-once');
    const result = await runQuantiply(context, CREDS);
    assert.equal(result.status, 'OK', result.detail);
    assert.equal(angelLoads(hits), 2);
    await context.close();
  });

  it('a return that bounces back to /auth is a failure, not a login', async (t) => {
    if (skip) return t.skip(skip);
    const { context } = await standIn('bounce');
    const result = await runQuantiply(context, CREDS);
    assert.equal(result.status, 'FAIL');
    assert.match(result.detail, /showed the login screen again.*NOT retried/);
    await context.close();
  });

  it('a session Quantiply already has counts once it holds, with no login sent', async (t) => {
    if (skip) return t.skip(skip);
    const { context, hits } = await standIn('already');
    const result = await runQuantiply(context, CREDS);
    assert.equal(result.status, 'SKIPPED', result.detail);
    assert.equal(angelLoads(hits), 0);
    await context.close();
  });

  it('a brief /algos that its auth guard sends back to /auth is not "already logged in"', async (t) => {
    if (skip) return t.skip(skip);
    const { context, hits } = await standIn('already-bounce');
    const result = await runQuantiply(context, CREDS);
    assert.equal(result.status, 'OK', result.detail);
    assert.equal(angelLoads(hits), 1);
    await context.close();
  });

  it('a hung page ends at the time limit, in a context of its own that is then closed', async (t) => {
    if (skip || !browser) return t.skip(skip || 'no browser');
    let used: BrowserContext | null = null;
    const result = await runQuantiplyIsolated(browser, CREDS, {
      timeLimitMs: 2_000,
      onContext: async (context) => {
        used = context;
        await install(context, 'hang', []);
      },
    });
    assert.equal(result.status, 'FAIL');
    assert.match(result.detail, /timed out after 2s/);
    assert.ok(used);
    assert.equal(browser.contexts().includes(used), false, 'the context must be closed');
  });
});
