import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { runQuantiply } from './quantiply.js';
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

type AngelOutcome = 'success' | 'invalid-pin' | 'bounce' | 'popup';

const ANGEL_URL =
  'https://smartapi.angelone.in/publisher-login/v1/?api_key=k&redirect_url=https%3A%2F%2Fapi-prod.quantiply.angelone.in%2Fauth%2Fangel%2Fredirect';

function quantiplyAuth(outcome: AngelOutcome): string {
  const open = outcome === 'popup' ? `window.open('${ANGEL_URL}')` : `location.href='${ANGEL_URL}'`;
  return `<!doctype html><title>Quantiply</title><button onclick="${open}">Login / Sign Up</button>`;
}

function angelPage(outcome: AngelOutcome): string {
  const onSubmit =
    outcome === 'invalid-pin'
      ? "document.getElementById('login-error').textContent='Invalid PIN';document.getElementById('login-error').style.display='block'"
      : "location.href='https://api-prod.quantiply.angelone.in/auth/angel/redirect?code=c'";
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

async function standIn(
  outcome: AngelOutcome,
): Promise<{ context: BrowserContext; hits: string[] }> {
  assert.ok(browser);
  const context = await browser.newContext();
  const hits: string[] = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const key = `${url.hostname}${url.pathname}`;
    hits.push(key);
    const html = (body: string) => route.fulfill({ contentType: 'text/html', body });
    if (key === 'app.quantiply.angelone.in/auth') return html(quantiplyAuth(outcome));
    if (key === 'smartapi.angelone.in/publisher-login/v1/') return html(angelPage(outcome));
    if (key === 'api-prod.quantiply.angelone.in/auth/angel/redirect') {
      return html("<script>location.replace('https://app.quantiply.angelone.in/algos')</script>");
    }
    if (key === 'app.quantiply.angelone.in/algos') {
      return html(outcome === 'bounce' ? BOUNCING_ALGOS : ALGOS);
    }
    return route.abort();
  });
  return { context, hits };
}

describe('Quantiply login (stand-in pages)', () => {
  it('logs in: Login / Sign Up -> Angel TOTP form -> back on /algos', async (t) => {
    if (skip) return t.skip(skip);
    const { context, hits } = await standIn('success');
    const result = await runQuantiply(context, CREDS);
    assert.equal(result.status, 'OK', result.detail);
    assert.match(result.detail, /^logged in \(\d+s\)$/);
    assert.ok(hits.includes('smartapi.angelone.in/publisher-login/v1/'));
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
    const angelLoads = hits.filter((h) => h.startsWith('smartapi.angelone.in')).length;
    assert.equal(angelLoads, 1, 'the credentials must be sent once only');
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
});
