import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { combineReports } from './morning-report-plan.js';

const line = (text: string) => `${JSON.stringify({ text })}\n`;

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

  it('no report at all is said, never silence', () => {
    assert.match(combineReports(null, '2026-10-28'), /no account reported/);
    assert.match(combineReports('not json\n', '2026-10-28'), /no account reported/);
  });
});
