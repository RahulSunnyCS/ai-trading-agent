import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { combineReports, loginLine } from './morning-report-plan.js';

const line = (text: string) => `${JSON.stringify({ text })}\n`;
const expect_ = (got: string | null, want: string) => assert.equal(got, want);

describe('one morning switch-on message (BL-172)', () => {
  it('puts both accounts under one heading', () => {
    const msg = combineReports(
      line('✅ Quantiply · Angel One morning switch-on for 2026-10-28 (WED)\nMTM SL ₹8,000 ✓') +
        line('✅ Quantiply · Shoonya morning switch-on for 2026-10-28 (WED)\nMTM SL ₹9,000 ✓'),
      '2026-10-28',
    );
    assert.equal(msg.split('\n')[0], '✅ Quantiply morning switch-on 2026-10-28');
    assert.match(
      msg,
      /\nQuantiply · Angel One morning switch-on[^\n]*\nMTM SL ₹8,000 ✓\n\nQuantiply · Shoonya/,
    );
  });

  it('one account needing a look makes the whole message a warning', () => {
    const msg = combineReports(
      line('✅ Quantiply · Angel One ...') + line('⚠️ Quantiply · Shoonya ...: check Quantiply'),
      '2026-10-28',
    );
    assert.match(msg, /^⚠️ Quantiply morning switch-on 2026-10-28: check Quantiply/);
  });

  it('an account that did not report is said', () => {
    const msg = combineReports(line('✅ Quantiply · Angel One ...'), '2026-10-28', 2);
    assert.match(msg, /^⚠️/);
    assert.match(msg, /1 account\(s\) did not report/);
  });

  it('the evening upload says nothing when no account wrote anything (BL-173)', () => {
    assert.equal(combineReports('', '2026-10-28', 0, 'Quantiply evening upload', true), null);
    assert.match(
      combineReports(line('⚠️ Shoonya ...'), '2026-10-28', 0, 'Quantiply evening upload', true) ??
        '',
      /^⚠️ Quantiply evening upload 2026-10-28/,
    );
  });

  it('the login line: names what logged in, warns on a failure (BL-173)', () => {
    const ok = (name: string) => ({ name, status: 'OK' });
    expect_(
      loginLine({
        ok: true,
        result: {
          algotest: null,
          quantiply: ok('Quantiply · Angel One'),
          quantiplyShoonya: ok('Quantiply · Shoonya'),
        },
      }),
      '✅ Logged in: Quantiply · Angel One · Quantiply · Shoonya',
    );
    expect_(
      loginLine({
        ok: false,
        result: {
          algotest: null,
          quantiply: ok('Quantiply · Angel One'),
          quantiplyShoonya: { name: 'Quantiply · Shoonya', status: 'FAIL' },
        },
      }),
      '⚠️ Login failed: Quantiply · Shoonya',
    );
    assert.equal(loginLine(null), null);
    assert.equal(loginLine({ ok: true, nothing: true }), null);
    expect_(loginLine({ ok: true, github: 'u' }), "✅ Logged in by GitHub's backup");
  });

  it("Kite's Friday and Monday login joins the line (owner, 2026-10-28)", () => {
    const kiteOk = { name: 'Kite', status: 'OK' };
    const kiteFail = { name: 'Kite', status: 'FAIL' };
    const quantiply = { name: 'Quantiply · Angel One', status: 'OK' };
    const result = { algotest: null, quantiply, quantiplyShoonya: null };
    expect_(
      loginLine({ ok: true, result, kite: kiteOk }),
      '✅ Logged in: Quantiply · Angel One · Kite',
    );
    expect_(loginLine({ ok: true, result, kite: kiteFail }), '⚠️ Login failed: Kite');
    expect_(loginLine({ ok: true, nothing: true, kite: kiteOk }), '✅ Logged in: Kite');
    expect_(loginLine({ ok: true, nothing: true, kite: kiteFail }), '⚠️ Login failed: Kite');
    expect_(
      loginLine({ ok: true, github: 'u', kite: kiteOk }),
      "✅ Logged in by GitHub's backup · Kite",
    );
    // switched off: not mentioned
    assert.equal(
      loginLine({ ok: true, nothing: true, kite: { name: 'Kite', status: 'SKIPPED' } }),
      null,
    );
  });

  it('no report at all is said, never silence', () => {
    assert.match(combineReports(null, '2026-10-28'), /no account reported/);
    assert.match(combineReports('not json\n', '2026-10-28'), /no account reported/);
  });
});
