import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  QUANTIPLY_LOGIN_URL,
  classifyQuantiplyError,
  isAngelLoginUrl,
  isQuantiplyLoggedInUrl,
  parseQuantiplyFlag,
  quantiplyFailureDetail,
  quantiplyRetryDecision,
} from './quantiply-rules.js';
import { totpWindow } from './totp.js';

const ANGEL =
  'https://smartapi.angelone.in/publisher-login/v1/?api_key=k&redirect_url=https://api-prod.quantiply.angelone.in/auth/angel/redirect';

describe('logged-in URL', () => {
  it('back on the Quantiply app outside /auth counts', () => {
    assert.ok(isQuantiplyLoggedInUrl('https://app.quantiply.angelone.in/algos'));
    assert.ok(isQuantiplyLoggedInUrl('https://app.quantiply.angelone.in/algos?tab=live'));
    assert.ok(isQuantiplyLoggedInUrl('https://app.quantiply.angelone.in/'));
    assert.ok(isQuantiplyLoggedInUrl('https://app.quantiply.angelone.in/authors'));
  });

  it('the login screen, the redirect leg and Angel’s page do not', () => {
    assert.ok(!isQuantiplyLoggedInUrl(QUANTIPLY_LOGIN_URL));
    assert.ok(!isQuantiplyLoggedInUrl('https://app.quantiply.angelone.in/auth'));
    assert.ok(!isQuantiplyLoggedInUrl('https://app.quantiply.angelone.in/auth/callback?x=1'));
    assert.ok(
      !isQuantiplyLoggedInUrl('https://api-prod.quantiply.angelone.in/auth/angel/redirect?c=1'),
    );
    assert.ok(!isQuantiplyLoggedInUrl(ANGEL));
    assert.ok(!isQuantiplyLoggedInUrl('http://app.quantiply.angelone.in/algos'));
    assert.ok(!isQuantiplyLoggedInUrl('https://app.quantiply.angelone.in.evil.example/algos'));
    assert.ok(!isQuantiplyLoggedInUrl('about:blank'));
    assert.ok(!isQuantiplyLoggedInUrl('not a url'));
  });

  it('Angel’s login page is told apart from Quantiply’s own angelone.in hosts', () => {
    assert.ok(isAngelLoginUrl(ANGEL));
    assert.ok(!isAngelLoginUrl(QUANTIPLY_LOGIN_URL));
    assert.ok(!isAngelLoginUrl('https://api-prod.quantiply.angelone.in/auth/angel/redirect'));
    assert.ok(!isAngelLoginUrl('garbage'));
  });
});

describe('error classification', () => {
  it('a wrong PIN or a locked account is never retryable', () => {
    assert.equal(classifyQuantiplyError('Invalid PIN'), 'CREDENTIALS_REJECTED');
    assert.equal(classifyQuantiplyError('Invalid MPIN entered'), 'CREDENTIALS_REJECTED');
    assert.equal(classifyQuantiplyError('Your account is locked'), 'CREDENTIALS_REJECTED');
    assert.equal(classifyQuantiplyError('Too many attempts'), 'CREDENTIALS_REJECTED');
  });

  it('a TOTP rejection is, and the AlgoTest window wording is not a Quantiply case', () => {
    assert.equal(classifyQuantiplyError('Invalid TOTP'), 'TOTP_REJECTED');
    assert.equal(classifyQuantiplyError('OTP expired'), 'TOTP_REJECTED');
    assert.equal(classifyQuantiplyError('allowed between 08:15 and 15:40'), 'UNKNOWN');
    assert.equal(classifyQuantiplyError('Something went wrong'), 'UNKNOWN');
    assert.equal(classifyQuantiplyError(''), 'UNKNOWN');
  });
});

describe('retry decision', () => {
  it('never retries a credentials rejection, even on the first attempt', () => {
    assert.equal(quantiplyRetryDecision('CREDENTIALS_REJECTED', true, 1, 2), 'stop');
  });

  it('retries a TOTP rejection once, with a code from the next window', () => {
    assert.equal(quantiplyRetryDecision('TOTP_REJECTED', true, 1, 2), 'retry-next-totp-window');
    assert.equal(quantiplyRetryDecision('TOTP_REJECTED', true, 2, 2), 'stop');
  });

  it('retries an unknown failure only if the credentials were not sent yet', () => {
    assert.equal(quantiplyRetryDecision('UNKNOWN', false, 1, 2), 'retry');
    assert.equal(quantiplyRetryDecision('UNKNOWN', true, 1, 2), 'stop');
    assert.equal(quantiplyRetryDecision('UNKNOWN', false, 2, 2), 'stop');
  });

  it('the report says why it stopped', () => {
    assert.match(
      quantiplyFailureDetail('Invalid PIN', 'CREDENTIALS_REJECTED', true),
      /NOT retried, check the ANGELONE_\* secrets/,
    );
    assert.match(quantiplyFailureDetail('x', 'TOTP_REJECTED', true), /ANGELONE_TOTP_SECRET/);
    assert.match(quantiplyFailureDetail('x', 'UNKNOWN', true), /credentials already sent/);
    assert.equal(quantiplyFailureDetail('selector', 'UNKNOWN', false), 'selector');
  });
});

describe('QUANTIPLY_LOGIN flag', () => {
  it('is off when unset or empty, so nothing new runs until the owner switches it on', () => {
    assert.equal(parseQuantiplyFlag(undefined), false);
    assert.equal(parseQuantiplyFlag(''), false);
    assert.equal(parseQuantiplyFlag('  '), false);
    assert.equal(parseQuantiplyFlag('off'), false);
    assert.equal(parseQuantiplyFlag('OFF'), false);
  });

  it('accepts on in the usual spellings and refuses anything else loudly', () => {
    for (const on of ['on', 'ON', ' on ', 'true', '1', 'yes']) {
      assert.equal(parseQuantiplyFlag(on), true);
    }
    assert.throws(
      () => parseQuantiplyFlag('angelone'),
      /QUANTIPLY_LOGIN=angelone is not on or off/,
    );
  });
});

describe('TOTP window', () => {
  it('is the 30-second step a time falls in', () => {
    assert.equal(totpWindow(0), 0);
    assert.equal(totpWindow(29_999), 0);
    assert.equal(totpWindow(30_000), 1);
  });
});
