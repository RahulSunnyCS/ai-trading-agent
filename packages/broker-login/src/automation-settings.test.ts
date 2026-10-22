import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_AUTOMATION,
  algotestMultiplierRefusal,
  describeSource,
  effectiveRow,
  pausedFor,
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
        s.rows['algotest.angelone'] = {
          login: true,
          list: 'core',
          upload: true,
          multiplier: 1,
          addon: true,
        };
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

describe('multiplier, add-on and pause (BL-140 Phase 4)', () => {
  const fixtures = join(import.meta.dirname, 'fixtures');
  const fixture = (name: string) => join(fixtures, name);

  it('a snapshot written before Phase 4 means multiplier 1, add-on yes and no pause', () => {
    const a = readAutomation(fixture('automation-settings-v1.json'));
    for (const row of Object.values(a.rows)) {
      assert.equal(row.multiplier, 1);
      assert.equal(row.addon, true);
    }
    assert.deepEqual(a.pause, { until: null });
    assert.equal(effectiveRow(a, 'quantiply', 'angelone').multiplier, 1);
    assert.equal(pausedFor(a, '2026-10-23'), null);
  });

  it('reads what the owner set and applies a pause to every session up to its last day', () => {
    const a = readAutomation(fixture('automation-settings-v2.json'));
    assert.equal(effectiveRow(a, 'quantiply', 'angelone').multiplier, 3);
    assert.equal(effectiveRow(a, 'quantiply', 'angelone').addon, false);
    assert.equal(effectiveRow(a, 'algotest', 'finvasia').multiplier, 2);
    assert.equal(pausedFor(a, '2026-10-26'), '2026-10-27');
    assert.equal(pausedFor(a, '2026-10-27'), '2026-10-27'); // inclusive
    assert.equal(pausedFor(a, '2026-10-28'), null);
  });

  it('refuses a bad multiplier, add-on or pause date rather than guessing', () => {
    for (const change of [
      (s: typeof DEFAULT_AUTOMATION) => {
        s.rows['quantiply.angelone'].multiplier = 0;
      },
      (s: typeof DEFAULT_AUTOMATION) => {
        s.rows['quantiply.angelone'].multiplier = 11;
      },
      (s: typeof DEFAULT_AUTOMATION) => {
        s.rows['quantiply.angelone'].multiplier = 1.5;
      },
      (s: typeof DEFAULT_AUTOMATION) => {
        (s.rows['quantiply.angelone'] as unknown as { multiplier: unknown }).multiplier = '3';
      },
      (s: typeof DEFAULT_AUTOMATION) => {
        (s.rows['algotest.finvasia'] as unknown as { addon: unknown }).addon = 'no';
      },
      (s: typeof DEFAULT_AUTOMATION) => {
        s.pause = { until: 'tomorrow' };
      },
    ]) {
      write(saved(change));
      assert.throws(() => readAutomation(file));
    }
  });
});

describe('the AlgoTest deployer and a multiplier it cannot set (BL-140 Phase 4)', () => {
  it('does not refuse at 1, and names a row that uploads at more', () => {
    assert.equal(algotestMultiplierRefusal(DEFAULT_AUTOMATION), null);
    const a = JSON.parse(JSON.stringify(DEFAULT_AUTOMATION)) as typeof DEFAULT_AUTOMATION;
    a.rows['algotest.finvasia'].multiplier = 3;
    assert.match(algotestMultiplierRefusal(a) ?? '', /finvasia 3.*deploy by hand/);
    // a row that uploads nothing, or a Quantiply row, does not matter to this deployer
    a.rows['algotest.finvasia'].multiplier = 1;
    a.rows['algotest.angelone'].multiplier = 5;
    assert.equal(algotestMultiplierRefusal(a), null);
    a.rows['quantiply.angelone'].multiplier = 4;
    assert.equal(algotestMultiplierRefusal(a), null);
  });
});
