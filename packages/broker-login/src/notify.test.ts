import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrokerResult } from './brokers/types.js';
import { formatReport } from './notify.js';
import { QUANTIPLY_NAME } from './quantiply.js';

const angel: BrokerResult = { name: 'Angel One', status: 'OK', detail: 'logged in (35s)' };
const finvasia: BrokerResult = { name: 'Finvasia', status: 'SKIPPED', detail: 'already logged in' };
const qOk: BrokerResult = { name: QUANTIPLY_NAME, status: 'OK', detail: 'logged in (22s)' };
const qFail: BrokerResult = {
  name: QUANTIPLY_NAME,
  status: 'FAIL',
  detail: 'Invalid PIN - NOT retried, check the ANGELONE_* secrets',
};

/** Drops the timestamp line, which changes every minute. */
function body(report: string): string[] {
  return report.split('\n').filter((line) => !line.includes(' IST'));
}

describe('formatReport', () => {
  it('without Quantiply is the AlgoTest-only report it always was', () => {
    const report = formatReport([angel, finvasia], null);
    assert.match(report, /\nAlgoTest broker login, .* IST\n/);
    assert.deepEqual(body(report), [
      '✅ All brokers ready (2/2)',
      '',
      '✅ Angel One — logged in (35s)',
      '🔁 Finvasia — already logged in',
    ]);
  });

  it('with Quantiply counts every login and labels each platform', () => {
    const report = formatReport([angel, finvasia], 'https://example.test/run/1', [qOk]);
    assert.match(report, /\nBroker login: AlgoTest \+ Quantiply, .* IST\n/);
    assert.deepEqual(body(report), [
      '✅ All logins ready (3/3)',
      '',
      '✅ AlgoTest · Angel One — logged in (35s)',
      '✅ Quantiply · Angel One — logged in (22s)',
      '🔁 AlgoTest · Finvasia — already logged in',
      '',
      '🔗 https://example.test/run/1',
    ]);
  });

  it('a Quantiply failure is listed first and does not hide the AlgoTest lines', () => {
    assert.deepEqual(body(formatReport([angel, finvasia], null, [qFail])), [
      '⚠️ Partial (2/3) - check now',
      '',
      '❌ Quantiply · Angel One — Invalid PIN - NOT retried, check the ANGELONE_* secrets',
      '✅ AlgoTest · Angel One — logged in (35s)',
      '🔁 AlgoTest · Finvasia — already logged in',
    ]);
  });

  it('AlgoTest never reaching the broker list still shows the Quantiply line', () => {
    assert.deepEqual(body(formatReport([], null, [qOk])), [
      '🚨 AlgoTest login never reached the broker list',
      '',
      '✅ Quantiply · Angel One — logged in (22s)',
    ]);
  });

  it('every login failing says so', () => {
    const fail: BrokerResult = { name: 'Angel One', status: 'FAIL', detail: 'x' };
    assert.equal(
      body(formatReport([fail], null, [qFail]))[0],
      '❌ All logins failed (0/2) - check now',
    );
  });
});

describe('formatReport with no AlgoTest login in the settings (ONLY=none, BL-140)', () => {
  const shoonyaFail: BrokerResult = {
    name: 'Quantiply · Shoonya',
    status: 'FAIL',
    detail: 'Invalid Input : Wrong Password - NOT retried',
  };

  it('names only Quantiply and has no AlgoTest line', () => {
    const report = formatReport(null, null, [qOk]);
    assert.match(report, /\nBroker login: Quantiply, .* IST\n/);
    assert.deepEqual(body(report), [
      '✅ All logins ready (1/1)',
      '',
      '✅ Quantiply · Angel One — logged in (22s)',
    ]);
  });

  it('a Quantiply · Shoonya failure counts in the verdict (27 Oct said 2/2 ready)', () => {
    assert.deepEqual(body(formatReport(null, null, [qOk, shoonyaFail])), [
      '⚠️ Partial (1/2) - check now',
      '',
      '❌ Quantiply · Shoonya — Invalid Input : Wrong Password - NOT retried',
      '✅ Quantiply · Angel One — logged in (22s)',
    ]);
  });

  it('nothing switched on says so, never a broken run', () => {
    const report = formatReport(null, null, []);
    assert.match(report, /^✅ Nothing to log in/);
    assert.doesNotMatch(report, /never reached/);
  });
});
