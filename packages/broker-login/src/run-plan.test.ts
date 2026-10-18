import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrokerResult } from './brokers/types.js';
import { WINDOW_OPENS_MINUTES, exitCode, istMinutesNow, quantiplyOrder } from './run-plan.js';

const at = (hh: number, mm: number) => hh * 60 + mm;

describe('quantiplyOrder', () => {
  it('is off when Quantiply is off or cannot run', () => {
    assert.equal(quantiplyOrder(false, false, at(8, 0)), 'off');
    assert.equal(quantiplyOrder(false, true, at(9, 0)), 'off');
  });

  it('goes first only while it can finish before the AlgoTest window opens', () => {
    assert.equal(WINDOW_OPENS_MINUTES, at(8, 16));
    assert.equal(quantiplyOrder(true, false, at(8, 0)), 'first'); // the laptop's 08:00 dispatch
    assert.equal(quantiplyOrder(true, false, at(8, 11)), 'first');
    assert.equal(quantiplyOrder(true, false, at(8, 12)), 'last'); // would run past 08:16
    assert.equal(quantiplyOrder(true, false, at(8, 15)), 'last'); // the 08:15 cron
  });

  it('goes last once the window is open or the guard is skipped', () => {
    assert.equal(quantiplyOrder(true, false, at(9, 8)), 'last'); // a late catch-up dispatch
    assert.equal(quantiplyOrder(true, false, at(15, 55)), 'last');
    assert.equal(quantiplyOrder(true, true, at(8, 0)), 'last'); // SKIP_WINDOW_GUARD
  });

  it('reads IST', () => {
    assert.equal(istMinutesNow(new Date('2026-10-19T02:30:00Z')), at(8, 0));
  });
});

describe('exitCode', () => {
  const ok: BrokerResult = { name: 'Finvasia', status: 'OK', detail: '' };
  const fail: BrokerResult = { name: 'Finvasia', status: 'FAIL', detail: '' };
  const qOk: BrokerResult = { name: 'Quantiply', status: 'OK', detail: '' };
  const qFail: BrokerResult = { name: 'Quantiply', status: 'FAIL', detail: '' };

  it('locally, a failure of either platform fails the run', () => {
    assert.equal(exitCode([ok], qOk, null, false), 0);
    assert.equal(exitCode([ok], null, null, false), 0);
    assert.equal(exitCode([ok], qFail, null, false), 1);
    assert.equal(exitCode([fail], qOk, null, false), 1);
    assert.equal(exitCode([], qOk, 'browser crashed', false), 1);
  });

  it('in Actions, a Quantiply-only failure leaves the AlgoTest step green (its own step fails)', () => {
    assert.equal(exitCode([ok], qFail, null, true), 0);
    assert.equal(exitCode([fail], qFail, null, true), 1);
    assert.equal(exitCode([ok], qOk, 'fatal', true), 1);
  });
});
