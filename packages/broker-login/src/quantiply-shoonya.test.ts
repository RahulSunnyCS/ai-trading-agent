import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { BrokerLoginError } from './brokers/types.js';
import {
  QUANTIPLY_SITES,
  isQuantiplyLoggedInUrl,
  isShoonyaLoginUrl,
  parseQuantiplyBroker,
} from './quantiply-rules.js';
import { quantiplyShoonyaLogin } from './quantiply-shoonya.js';

/**
 * Quantiply · Shoonya in real Chromium against stand-in pages: every request is answered by the
 * route below and anything else is aborted, so nothing reaches Quantiply or Shoonya and no real
 * credentials exist here. The stand-ins copy what was seen on 2026-10-19: one "Login / Sign Up"
 * button on quantiply.shoonya.com/auth, a same-tab hop to Shoonya's OAuth page with the
 * `finvasiaForm` ids, then back to /algos. Skipped where no browser is installed.
 */

process.chdir(mkdtempSync(join(tmpdir(), 'broker-login-qshoonya-')));

const CREDS = { userId: 'FA0000', password: 'x', totpSecret: 'JBSWY3DPEHPK3PXP' };
const SHOONYA =
  'https://api.shoonya.com/OAuthlogin/investor-entry-level/login?api_key=k&route_to=QUANTIPLY';
const BACK = "location.href='https://quantiply.shoonya.com/algos'";

type Outcome = 'success' | 'consent' | 'wrong-password' | 'already';

function shoonyaPage(outcome: Outcome): string {
  if (outcome === 'consent') {
    return `<!doctype html><title>Login | SHOONYA</title><button onclick="${BACK}">Authorize</button>`;
  }
  const onSubmit =
    outcome === 'wrong-password' ? "document.getElementById('err').hidden=false" : BACK;
  return `<!doctype html><title>Login | SHOONYA</title>
    <input id="lgnusrid"><input id="lgnpwd" type="password"><input id="lgnotp" type="password">
    <button class="lgnBtnClss" onclick="${onSubmit}">LOGIN</button>
    <div id="err" hidden>Invalid password</div>`;
}

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

async function standIn(outcome: Outcome): Promise<{ context: BrowserContext; filled: string[] }> {
  assert.ok(browser);
  const context = await browser.newContext();
  const filled: string[] = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const key = `${url.hostname}${url.pathname}`;
    const html = (body: string) => route.fulfill({ contentType: 'text/html', body });
    if (key === 'quantiply.shoonya.com/auth') {
      if (outcome === 'already') return html("<script>location.replace('/algos')</script>");
      return html(
        `<!doctype html><button onclick="location.href='${SHOONYA}'">Login / Sign Up</button>`,
      );
    }
    if (key === 'api.shoonya.com/OAuthlogin/investor-entry-level/login') {
      filled.push('shoonya');
      return html(shoonyaPage(outcome));
    }
    if (key === 'quantiply.shoonya.com/algos') return html('<!doctype html><h1>Algos</h1>');
    return route.abort();
  });
  return { context, filled };
}

describe('Quantiply · Shoonya rules', () => {
  it('knows both sites and tells their hosts apart', () => {
    assert.equal(QUANTIPLY_SITES.finvasia.apiOrigin, 'https://api-prod.quantiply.shoonya.com');
    assert.equal(
      isQuantiplyLoggedInUrl('https://quantiply.shoonya.com/algos', 'quantiply.shoonya.com'),
      true,
    );
    assert.equal(
      isQuantiplyLoggedInUrl('https://quantiply.shoonya.com/auth', 'quantiply.shoonya.com'),
      false,
    );
    // The default stays Angel One's host, so existing callers are unchanged.
    assert.equal(isQuantiplyLoggedInUrl('https://quantiply.shoonya.com/algos'), false);
    assert.equal(isShoonyaLoginUrl(SHOONYA), true);
    assert.equal(isShoonyaLoginUrl('https://api.shoonya.com/other'), false);
    assert.equal(parseQuantiplyBroker(undefined), 'angelone');
    assert.equal(parseQuantiplyBroker('finvasia'), 'finvasia');
    assert.throws(() => parseQuantiplyBroker('zerodha'), /not angelone or finvasia/);
  });
});

describe('quantiplyShoonyaLogin (stand-in pages)', () => {
  it("fills Shoonya's form and lands on /algos", async (t) => {
    if (skip) return t.skip(skip);
    const { context, filled } = await standIn('success');
    const page = await context.newPage();
    assert.equal(await quantiplyShoonyaLogin(page, CREDS), 'logged_in');
    assert.equal(new URL(page.url()).pathname, '/algos');
    assert.deepEqual(filled, ['shoonya']);
    await context.close();
  });

  it('clicks Authorize when Shoonya shows its consent screen', async (t) => {
    if (skip) return t.skip(skip);
    const { context } = await standIn('consent');
    const page = await context.newPage();
    assert.equal(await quantiplyShoonyaLogin(page, CREDS), 'logged_in');
    await context.close();
  });

  it('reports a rejected password as such', async (t) => {
    if (skip) return t.skip(skip);
    const { context } = await standIn('wrong-password');
    const page = await context.newPage();
    await assert.rejects(quantiplyShoonyaLogin(page, CREDS), (error: unknown) => {
      assert.ok(error instanceof BrokerLoginError);
      assert.match(error.message, /Invalid password/);
      return true;
    });
    await context.close();
  });

  it('returns already when Quantiply skips its login', async (t) => {
    if (skip) return t.skip(skip);
    const { context, filled } = await standIn('already');
    const page = await context.newPage();
    assert.equal(await quantiplyShoonyaLogin(page, CREDS), 'already');
    assert.deepEqual(filled, []);
    await context.close();
  });
});
