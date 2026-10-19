import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_AUTOMATION,
  describeSource,
  effectiveRow,
  readAutomation,
  settingsPath,
  uploadBooks,
} from './automation-settings.js';

const dir = mkdtempSync(join(tmpdir(), 'broker-login-automation-'));
const file = join(dir, 'automation-settings.json');
const write = (value: unknown) => writeFileSync(file, JSON.stringify(value));
const saved = (change: (s: typeof DEFAULT_AUTOMATION) => void) => {
  const s = JSON.parse(JSON.stringify(DEFAULT_AUTOMATION)) as typeof DEFAULT_AUTOMATION;
  s.version = 4;
  change(s);
  return s;
};

describe('automation settings for the jobs (BL-140)', () => {
  it("no file is today's setup, so the jobs behave as before", () => {
    const a = readAutomation(join(dir, 'missing.json'));
    assert.equal(a.source, 'default');
    assert.deepEqual(uploadBooks(a, 'algotest'), ['t1']);
    assert.deepEqual(uploadBooks(a, 'quantiply', 'angelone'), ['core']);
    assert.deepEqual(uploadBooks(a, 'quantiply', 'finvasia'), []);
    assert.equal(describeSource(a), 'settings: defaults (none saved yet)');
  });

  it('a saved file decides, and the master switches gate every row', () => {
    write(
      saved((s) => {
        s.rows['algotest.angelone'] = { login: true, list: 'core', upload: true };
      }),
    );
    let a = readAutomation(file);
    assert.equal(describeSource(a), 'settings v4');
    assert.deepEqual(uploadBooks(a, 'algotest'), ['core', 't1']);
    write(
      saved((s) => {
        s.masters.uploads = false;
        s.masters.logins = false;
      }),
    );
    a = readAutomation(file);
    assert.deepEqual(uploadBooks(a, 'algotest'), []);
    assert.equal(effectiveRow(a, 'algotest', 'finvasia').login, false);
  });

  it('refuses a file that is not settings, rather than guess', () => {
    write({ masters: {} });
    assert.throws(() => readAutomation(file), /not automation settings/);
    write(
      saved((s) => {
        (s.rows['algotest.finvasia'] as { list: string }).list = 'classic';
      }),
    );
    assert.throws(() => readAutomation(file), /algotest\.finvasia has list "classic"/);
  });

  it('lives beside the scheduler database', () => {
    assert.equal(settingsPath({ SCHEDULER_STATE_DIR: '/x' }), '/x/automation-settings.json');
  });
});
