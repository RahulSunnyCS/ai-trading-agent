import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { loadConfig } from './config.js';

// loadConfig() reads ./.env when there is one; run from an empty folder so a developer's real
// .env can never fill in a value these tests leave out.
process.chdir(mkdtempSync(join(tmpdir(), 'broker-login-config-')));

const KEYS = [
  'ALGOTEST_PHONE',
  'ALGOTEST_PASSWORD',
  'ANGELONE_CLIENT_CODE',
  'ANGELONE_MPIN',
  'ANGELONE_TOTP_SECRET',
  'SHOONYA_CLIENT_ID',
  'SHOONYA_PASSWORD',
  'SHOONYA_TOTP_SECRET',
  'ONLY',
  'QUANTIPLY_LOGIN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
];

const ALGOTEST = { ALGOTEST_PHONE: '9876543210', ALGOTEST_PASSWORD: 'test-pass' };
const ANGEL = {
  ANGELONE_CLIENT_CODE: 'TEST01',
  ANGELONE_MPIN: '0000',
  ANGELONE_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
};
const FINVASIA = {
  SHOONYA_CLIENT_ID: 'FA0000',
  SHOONYA_PASSWORD: 'test-fv',
  SHOONYA_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
};

function env(values: Record<string, string>): void {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

describe('QUANTIPLY_LOGIN in loadConfig', () => {
  beforeEach(() => env({}));

  it('is off by default', () => {
    env({ ...ALGOTEST, ...ANGEL, ...FINVASIA });
    assert.equal(loadConfig().quantiply, false);
  });

  it('on with ONLY=finvasia still requires the Angel One secrets', () => {
    env({ ...ALGOTEST, ...FINVASIA, ONLY: 'finvasia', QUANTIPLY_LOGIN: 'on' });
    assert.throws(
      () => loadConfig(),
      /Missing required environment variables: ANGELONE_CLIENT_CODE, ANGELONE_MPIN, ANGELONE_TOTP_SECRET/,
    );
  });

  it('on with ONLY=finvasia reads them, so Quantiply has its credentials', () => {
    env({ ...ALGOTEST, ...FINVASIA, ...ANGEL, ONLY: 'finvasia', QUANTIPLY_LOGIN: 'on' });
    const config = loadConfig();
    assert.equal(config.quantiply, true);
    assert.equal(config.only, 'finvasia');
    assert.equal(config.angelone.clientCode, 'TEST01');
    assert.equal(config.angelone.totpSecret, 'JBSWY3DPEHPK3PXP');
  });

  it('off with ONLY=finvasia leaves the Angel One secrets unneeded, as before', () => {
    env({ ...ALGOTEST, ...FINVASIA, ONLY: 'finvasia', QUANTIPLY_LOGIN: 'off' });
    const config = loadConfig();
    assert.equal(config.quantiply, false);
    assert.equal(config.angelone.clientCode, '');
  });

  it('on never asks for Finvasia secrets that ONLY=angelone leaves out', () => {
    env({ ...ALGOTEST, ...ANGEL, ONLY: 'angelone', QUANTIPLY_LOGIN: 'on' });
    assert.equal(loadConfig().quantiply, true);
  });

  it('an unknown value fails loudly instead of guessing', () => {
    env({ ...ALGOTEST, ...ANGEL, ...FINVASIA, QUANTIPLY_LOGIN: 'maybe' });
    assert.throws(() => loadConfig(), /QUANTIPLY_LOGIN=maybe is not on or off/);
  });
});
