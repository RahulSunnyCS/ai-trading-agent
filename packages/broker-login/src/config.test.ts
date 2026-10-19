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
  'QUANTIPLY_BROKERS',
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

  it('on with ONLY=finvasia and blank Angel One secrets: a Quantiply problem, AlgoTest still runs', () => {
    env({ ...ALGOTEST, ...FINVASIA, ONLY: 'finvasia', QUANTIPLY_LOGIN: 'on' });
    const config = loadConfig();
    assert.equal(config.quantiply, true);
    assert.equal(
      config.quantiplyProblem,
      'not run - missing ANGELONE_CLIENT_CODE, ANGELONE_MPIN, ANGELONE_TOTP_SECRET',
    );
    assert.equal(config.finvasia.clientId, 'FA0000');
    assert.equal(config.angelone.clientCode, '');
  });

  it('blank Angel One secrets still stop the run when AlgoTest itself needs them', () => {
    env({ ...ALGOTEST, ...FINVASIA, QUANTIPLY_LOGIN: 'on' });
    assert.throws(
      () => loadConfig(),
      /Missing required environment variables: ANGELONE_CLIENT_CODE/,
    );
  });

  it('on with ONLY=finvasia reads them, so Quantiply has its credentials', () => {
    env({ ...ALGOTEST, ...FINVASIA, ...ANGEL, ONLY: 'finvasia', QUANTIPLY_LOGIN: 'on' });
    const config = loadConfig();
    assert.equal(config.quantiply, true);
    assert.equal(config.quantiplyProblem, null);
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

  it('an unknown value is a Quantiply FAIL line, never a guess and never a stopped run', () => {
    env({ ...ALGOTEST, ...ANGEL, ...FINVASIA, QUANTIPLY_LOGIN: 'maybe' });
    const config = loadConfig();
    assert.equal(config.quantiply, true);
    assert.equal(config.quantiplyProblem, 'not run - QUANTIPLY_LOGIN=maybe is not on or off');
  });
});

describe('BL-140 settings in loadConfig', () => {
  beforeEach(() => env({}));

  it('ONLY=none needs no broker secrets and logs no AlgoTest broker in', () => {
    env({ ...ALGOTEST, ONLY: 'none' });
    const config = loadConfig();
    assert.equal(config.only, 'none');
    assert.equal(config.finvasia.clientId, '');
    assert.equal(config.angelone.clientCode, '');
  });

  it('still refuses an unknown ONLY', () => {
    env({ ...ALGOTEST, ...ANGEL, ...FINVASIA, ONLY: 'zerodha' });
    assert.throws(() => loadConfig(), /expected: angelone, finvasia, none/);
  });

  it('QUANTIPLY_BROKERS listing finvasia turns Quantiply · Shoonya on and reads its secrets', () => {
    env({ ...ALGOTEST, ...FINVASIA, ONLY: 'none', QUANTIPLY_BROKERS: 'angelone, finvasia' });
    const config = loadConfig();
    assert.equal(config.quantiplyShoonya, true);
    assert.equal(config.finvasia.clientId, 'FA0000');
  });

  it('Quantiply · Shoonya is off without it', () => {
    env({ ...ALGOTEST, ...ANGEL, ...FINVASIA, QUANTIPLY_BROKERS: 'angelone' });
    assert.equal(loadConfig().quantiplyShoonya, false);
  });
});
