import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_AUTOMATION } from './automation-settings.js';
import {
  type LoginResult,
  allLoggedIn,
  changedSecrets,
  combineParts,
  fallback,
  githubLoggedInToday,
  kiteDue,
  kiteResult,
  loginEnv,
  parsePart,
  partEnv,
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
  it('runs on every day the job runs, only with KITE_AUTO_LOGIN=on', () => {
    const on = { KITE_AUTO_LOGIN: 'on' };
    assert.equal(kiteDue('2026-10-30', on), true); // a Friday
    assert.equal(kiteDue('2026-11-02', on), true); // a Monday
    assert.equal(kiteDue('2026-10-28', on), true); // a Wednesday too (owner, 2026-11-06)
    assert.equal(kiteDue('2026-11-03', { KITE_AUTO_LOGIN: ' ON ' }), true); // a Tuesday
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

describe('the login in two parts (BL-234 Phase 4)', () => {
  const env = {
    ONLY: '',
    QUANTIPLY_LOGIN: 'on' as const,
    QUANTIPLY_BROKERS: 'angelone,finvasia',
  };

  it('parses --part, refusing anything else', () => {
    assert.equal(parsePart(undefined), 'all');
    assert.equal(parsePart('quantiply'), 'quantiply');
    assert.equal(parsePart('algotest'), 'algotest');
    assert.throws(() => parsePart('shoonya'), /expected quantiply/);
  });

  it('gives Quantiply · Angel One alone to the first part, AlgoTest and Shoonya to the second', () => {
    assert.deepEqual(partEnv(env, 'quantiply'), {
      ONLY: 'none',
      QUANTIPLY_LOGIN: 'on',
      QUANTIPLY_BROKERS: 'angelone',
    });
    assert.deepEqual(partEnv(env, 'algotest'), {
      ONLY: '',
      QUANTIPLY_LOGIN: 'off',
      QUANTIPLY_BROKERS: 'finvasia',
    });
    assert.equal(partEnv(env, 'all'), env);
  });

  it('asks a part nothing when the settings leave it out', () => {
    assert.equal(
      partEnv({ ...env, QUANTIPLY_LOGIN: 'off', QUANTIPLY_BROKERS: '' }, 'quantiply'),
      null,
    );
    assert.equal(
      partEnv({ ONLY: 'none', QUANTIPLY_LOGIN: 'on', QUANTIPLY_BROKERS: 'angelone' }, 'algotest'),
      null,
    );
    // Shoonya's Quantiply login alone still belongs to the second part
    assert.deepEqual(
      partEnv({ ONLY: 'none', QUANTIPLY_LOGIN: 'off', QUANTIPLY_BROKERS: 'finvasia' }, 'algotest'),
      { ONLY: 'none', QUANTIPLY_LOGIN: 'off', QUANTIPLY_BROKERS: 'finvasia' },
    );
  });

  it("combines each part's body, and a part run again replaces its own", () => {
    const first = {
      ok: true,
      result: {
        algotest: null,
        quantiply: ok('Quantiply · Angel One'),
        quantiplyShoonya: null,
        fatal: null,
      },
    };
    const second = {
      ok: false,
      fallback: { parts: ['AlgoTest · Finvasia'], url: 'https://gh/1' },
      result: {
        algotest: [fail('Finvasia', 'timeout')],
        quantiply: null,
        quantiplyShoonya: ok('Quantiply · Shoonya'),
        fatal: null,
      },
    };
    const both = combineParts({ quantiply: first, algotest: second });
    assert.equal(both.ok, false);
    assert.deepEqual(both.fallback, { parts: ['AlgoTest · Finvasia'], url: 'https://gh/1' });
    assert.equal(both.result?.quantiply?.status, 'OK');
    assert.equal(both.result?.algotest?.[0]?.status, 'FAIL');
    assert.equal(both.result?.quantiplyShoonya?.status, 'OK');
    const fixed = combineParts({
      quantiply: first,
      algotest: { ok: true, result: { ...second.result, algotest: [ok('Finvasia')] } },
    });
    assert.equal(fixed.ok, true);
    assert.equal(fixed.fallback, undefined);
  });

  it('is nothing to log in only when every part says so', () => {
    assert.equal(
      combineParts({ a: { ok: true, nothing: true }, b: { ok: true, nothing: true } }).nothing,
      true,
    );
    assert.equal(
      combineParts({ a: { ok: true, nothing: true }, b: { ok: true } }).nothing,
      undefined,
    );
  });
});

describe("GitHub's own run counts, ours does not (BL-234 Phase 4 review)", () => {
  const run = (url: string, createdAt: string, conclusion = 'success') => ({
    url,
    createdAt,
    conclusion,
  });
  // the Quantiply part handed Quantiply · Angel One to GitHub (only=none) and it succeeded
  const quantiplyOnly = {
    parts: {
      quantiply: {
        ok: false,
        fallback: {
          parts: ['Quantiply · Angel One'],
          url: 'https://gh/runs/1',
          at: '2026-11-20T02:36:00.000Z',
        },
      },
    },
  };

  it("does not take the Quantiply part's own Quantiply-only run for a login of AlgoTest", () => {
    const runs = [run('https://gh/runs/1', '2026-11-20T02:36:02.000Z')];
    assert.equal(githubLoggedInToday(runs, quantiplyOnly), undefined);
  });

  it('still counts a full run the backstop or the owner started', () => {
    const runs = [
      run('https://gh/runs/1', '2026-11-20T02:36:02.000Z'),
      run('https://gh/runs/2', '2026-11-20T02:45:00.000Z'),
    ];
    assert.equal(githubLoggedInToday(runs, quantiplyOnly)?.url, 'https://gh/runs/2');
    assert.equal(githubLoggedInToday(runs, null)?.url, 'https://gh/runs/1');
    assert.equal(githubLoggedInToday(runs, { parts: {} })?.url, 'https://gh/runs/1');
  });

  it('a failed run is never a login', () => {
    assert.equal(
      githubLoggedInToday([run('https://gh/runs/3', '2026-11-20T02:40:00.000Z', 'failure')], null),
      undefined,
    );
  });

  it('when the dispatched run was not found, every run created from the dispatch is ours', () => {
    const lost = {
      parts: {
        quantiply: {
          ok: false,
          fallback: {
            parts: ['Quantiply · Angel One'],
            url: '(dispatched; the run did not appear within 30 s)',
            at: '2026-11-20T02:36:00.000Z',
          },
        },
      },
    };
    const runs = [
      run('https://gh/runs/1', '2026-11-20T02:36:09.000Z'),
      run('https://gh/runs/0', '2026-11-20T02:30:00.000Z'),
    ];
    assert.equal(githubLoggedInToday(runs, lost)?.url, 'https://gh/runs/0');
  });
});
