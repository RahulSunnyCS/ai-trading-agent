import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_AUTOMATION } from './automation-settings.js';
import {
  type LoginResult,
  allLoggedIn,
  changedSecrets,
  fallback,
  kiteDue,
  kiteResult,
  loginEnv,
  secretsReminder,
} from './local-login-plan.js';

const settings = (change: (s: typeof DEFAULT_AUTOMATION) => void) => {
  const s = JSON.parse(JSON.stringify(DEFAULT_AUTOMATION)) as typeof DEFAULT_AUTOMATION;
  change(s);
  return s;
};
// the owner's settings v6: no AlgoTest login, Quantiply on both accounts
const v6 = settings((s) => {
  s.rows['algotest.finvasia'].login = false;
  s.rows['quantiply.finvasia'].login = true;
});
const ok = (name: string) => ({ name, status: 'OK' as const, detail: 'logged in (20s)' });
const fail = (name: string, detail: string) => ({ name, status: 'FAIL' as const, detail });

describe('the Mac login (BL-172)', () => {
  it('follows the settings, as the GitHub variables did', () => {
    assert.deepEqual(loginEnv(v6), {
      ONLY: 'none',
      QUANTIPLY_LOGIN: 'on',
      QUANTIPLY_BROKERS: 'finvasia,angelone',
    });
    assert.deepEqual(loginEnv(DEFAULT_AUTOMATION), {
      ONLY: 'finvasia',
      QUANTIPLY_LOGIN: 'on',
      QUANTIPLY_BROKERS: 'angelone',
    });
    assert.equal(
      loginEnv(
        settings((s) => {
          s.masters.logins = false;
        }),
      ),
      null,
    );
  });

  it('all logged in: nothing for GitHub', () => {
    const env = loginEnv(v6);
    assert.ok(env);
    const r: LoginResult = {
      algotest: null,
      quantiply: ok('Quantiply · Angel One'),
      quantiplyShoonya: ok('Quantiply · Shoonya'),
      fatal: null,
    };
    assert.equal(allLoggedIn(r), true);
    assert.equal(fallback(env, r), null);
  });

  it('a refused password is never handed to GitHub; a network failure is', () => {
    const env = loginEnv(v6);
    assert.ok(env);
    const r: LoginResult = {
      algotest: null,
      quantiply: fail('Quantiply · Angel One', 'net::ERR_INTERNET_DISCONNECTED'),
      quantiplyShoonya: fail('Quantiply · Shoonya', 'Invalid Input : Wrong Password - NOT retried'),
      fatal: null,
    };
    assert.equal(allLoggedIn(r), false);
    assert.deepEqual(fallback(env, r), {
      only: 'none',
      quantiply: 'on',
      quantiplyShoonya: 'off',
      parts: ['Quantiply · Angel One'],
    });
    const refusedOnly = {
      ...r,
      quantiply: fail('Quantiply · Angel One', 'Invalid PIN - NOT retried'),
    };
    assert.equal(fallback(env, refusedOnly), null);
  });

  it('no result at all (a crash) tries every asked part', () => {
    const env = loginEnv(DEFAULT_AUTOMATION);
    assert.ok(env);
    assert.deepEqual(fallback(env, null), {
      only: 'finvasia',
      quantiply: 'on',
      quantiplyShoonya: 'off',
      parts: ['AlgoTest · Finvasia', 'Quantiply · Angel One'],
    });
  });

  it('an AlgoTest broker failure goes back for that broker only', () => {
    const env = loginEnv(
      settings((s) => {
        s.rows['algotest.angelone'].login = true;
      }),
    );
    assert.ok(env);
    assert.equal(env.ONLY, '');
    const r: LoginResult = {
      algotest: [ok('Finvasia'), fail('Angel One', 'row not found on My Brokers')],
      quantiply: ok('Quantiply · Angel One'),
      quantiplyShoonya: null,
      fatal: null,
    };
    assert.deepEqual(fallback(env, r)?.only, 'angelone');
    const both: LoginResult = { ...r, algotest: [], fatal: 'page.goto: Timeout' };
    assert.deepEqual(fallback(env, both)?.only, '');
  });
});

describe('the GitHub secrets reminder (BL-172 Phase 3)', () => {
  it('names only the secrets whose digest changed, and never on the first run', () => {
    const now = { SHOONYA_PASSWORD: 'b', ANGELONE_MPIN: 'x' };
    assert.deepEqual(changedSecrets(null, now), []);
    assert.deepEqual(changedSecrets({ SHOONYA_PASSWORD: 'a', ANGELONE_MPIN: 'x' }, now), [
      'SHOONYA_PASSWORD',
    ]);
    const text = secretsReminder(['SHOONYA_PASSWORD']);
    assert.match(text, /gh secret set SHOONYA_PASSWORD/);
    assert.match(text, /grep '\^SHOONYA_PASSWORD=' \.env/);
  });
});

describe("Kite's unattended login (owner, 2026-10-28)", () => {
  it('runs on Fridays and Mondays, only with KITE_AUTO_LOGIN=on', () => {
    const on = { KITE_AUTO_LOGIN: 'on' };
    assert.equal(kiteDue('2026-10-30', on), true); // a Friday
    assert.equal(kiteDue('2026-11-02', on), true); // a Monday
    assert.equal(kiteDue('2026-10-28', on), false); // a Wednesday
    assert.equal(kiteDue('2026-10-30', {}), false);
    assert.equal(kiteDue('2026-10-30', { KITE_AUTO_LOGIN: 'off' }), false);
  });

  it("reads mbt's outcome, and nothing unreadable passes for one", () => {
    assert.deepEqual(kiteResult('{"status":"OK","detail":"Kite connected.","name":"Kite"}'), {
      name: 'Kite',
      status: 'OK',
      detail: 'Kite connected.',
    });
    assert.equal(kiteResult(null), null);
    assert.equal(kiteResult('not json'), null);
    assert.equal(kiteResult('{"status":"MAYBE"}'), null);
  });
});
