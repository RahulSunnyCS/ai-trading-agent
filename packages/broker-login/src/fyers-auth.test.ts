import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type FyersConfig,
  appIdHash,
  buildAuthUrl,
  classifyFyersError,
  exchangeAuthCode,
  isRedirect,
  loadFyersConfig,
  parseRedirect,
} from './fyers-auth.js';

const config: FyersConfig = {
  appId: 'ABCD1234-100',
  appSecret: 'shh-secret',
  redirectUri: 'http://localhost:3000/api/auth/fyers/callback',
  clientId: 'XY01234',
  pin: '1234',
  totpSecret: 'JBSWY3DPEHPK3PXP',
};

test('auth URL carries the app, redirect and state', () => {
  const { url, state } = buildAuthUrl(config, 'st4te');
  const params = new URL(url).searchParams;
  assert.equal(state, 'st4te');
  assert.equal(params.get('client_id'), 'ABCD1234-100');
  assert.equal(params.get('redirect_uri'), config.redirectUri);
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('state'), 'st4te');
});

test('only our redirect URI counts as the redirect', () => {
  assert.ok(isRedirect(`${config.redirectUri}?auth_code=x&state=s`, config.redirectUri));
  assert.ok(!isRedirect('https://login.fyers.in/?redirect=localhost', config.redirectUri));
  assert.ok(!isRedirect('http://localhost:3000/other', config.redirectUri));
});

test('auth code is read from the redirect and state is checked', () => {
  const url = `${config.redirectUri}?s=ok&code=200&auth_code=eyJ.long.code&state=s1`;
  assert.equal(parseRedirect(url, 's1'), 'eyJ.long.code');
  assert.throws(() => parseRedirect(url, 'other'), /state/);
  assert.throws(
    () => parseRedirect(`${config.redirectUri}?s=ok&code=200&state=s1`, 's1'),
    /auth_code/,
  );
  assert.throws(() => parseRedirect(`${config.redirectUri}?s=error&state=s1`, 's1'), /s=error/);
});

test('appIdHash is sha256 of "appId:secret", as Fyers requires', () => {
  assert.equal(
    appIdHash('a', 'b'),
    '6783a31eabf68ccc0660f935c0826282bdd2241f3a80a9f2d10d59aea9ebb5d8',
  );
  assert.match(appIdHash(config.appId, config.appSecret), /^[0-9a-f]{64}$/);
  assert.notEqual(appIdHash('a', 'b'), appIdHash('a', 'c'));
});

test('token exchange returns the token and never echoes a failed body', async () => {
  const ok = async () =>
    new Response(JSON.stringify({ s: 'ok', access_token: 'tok-123456' }), { status: 200 });
  const token = await exchangeAuthCode(config, 'code', ok as typeof fetch);
  assert.equal(token.accessToken, 'tok-123456');
  assert.equal(token.appId, config.appId);

  const bad = async () =>
    new Response(JSON.stringify({ s: 'error', message: 'invalid auth code', access_token: '' }), {
      status: 400,
    });
  await assert.rejects(exchangeAuthCode(config, 'code', bad as typeof fetch), /invalid auth code/);

  const html = async () => new Response('<html>gateway</html>', { status: 502 });
  await assert.rejects(exchangeAuthCode(config, 'code', html as typeof fetch), /HTTP 502/);
});

test('only a TOTP rejection is retryable', () => {
  assert.equal(classifyFyersError('Invalid TOTP, please try again'), 'TOTP_REJECTED');
  assert.equal(classifyFyersError('Incorrect PIN. 2 attempts left'), 'PIN_REJECTED');
  assert.equal(classifyFyersError('Your account is blocked'), 'ACCOUNT_BLOCKED');
  assert.equal(classifyFyersError('Something went wrong'), 'UNKNOWN');
});

test('config needs every variable and a 4-digit PIN', () => {
  const env = {
    FYERS_APP_ID: 'A-100',
    FYERS_APP_SECRET: 's',
    FYERS_REDIRECT_URI: 'http://localhost/cb',
    FYERS_CLIENT_ID: 'XY1',
    FYERS_PIN: '1234',
    FYERS_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
  };
  assert.equal(loadFyersConfig(env).clientId, 'XY1');
  assert.throws(() => loadFyersConfig({ ...env, FYERS_PIN: '' }), /FYERS_PIN/);
  assert.throws(() => loadFyersConfig({ ...env, FYERS_PIN: '12345' }), /4-digit/);
});
