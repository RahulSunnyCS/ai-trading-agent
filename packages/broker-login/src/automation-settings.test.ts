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
          dirBoost: false,
          mtmSl: null,
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

describe('Dir ×2 on non-expiry days (BL-183)', () => {
  it('a snapshot before BL-183 reads as off; a saved value reaches the row', () => {
    const a = readAutomation(join(import.meta.dirname, 'fixtures', 'automation-settings-v2.json'));
    assert.ok(Object.values(a.rows).every((r) => r.dirBoost === false));
    write(
      saved((s) => {
        s.rows['quantiply.angelone'].dirBoost = true;
      }),
    );
    assert.equal(effectiveRow(readAutomation(file), 'quantiply', 'angelone').dirBoost, true);
    assert.equal(effectiveRow(readAutomation(file), 'algotest', 'finvasia').dirBoost, false);
  });

  it('refuses a value that is not true or false', () => {
    write(
      saved((s) => {
        (s.rows['quantiply.angelone'] as unknown as { dirBoost: unknown }).dirBoost = 'yes';
      }),
    );
    assert.throws(() => readAutomation(file), /dirBoost "yes"/);
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

describe('MTM SL per Quantiply row (BL-172)', () => {
  it('a snapshot without the field reads as the list stop on Quantiply, none on AlgoTest', () => {
    const s = JSON.parse(JSON.stringify(DEFAULT_AUTOMATION)) as {
      rows: Record<string, Record<string, unknown>>;
    };
    const rowOf = (k: string) => s.rows[k] as Record<string, unknown>;
    for (const row of Object.values(s.rows) as Record<string, unknown>[]) delete row.mtmSl;
    rowOf('quantiply.finvasia').list = 't1';
    write(s);
    const a = readAutomation(file);
    assert.equal(a.rows['quantiply.angelone'].mtmSl, 8000);
    assert.equal(a.rows['quantiply.finvasia'].mtmSl, 9000);
    assert.equal(a.rows['algotest.finvasia'].mtmSl, null);
  });

  it('a bad figure, or one on AlgoTest, is an error, never a guess', () => {
    for (const [key, bad] of [
      ['quantiply.angelone', 80.5],
      ['quantiply.angelone', '8000'],
      ['algotest.finvasia', 8000],
    ] as const) {
      const s = JSON.parse(JSON.stringify(DEFAULT_AUTOMATION)) as {
        rows: Record<string, Record<string, unknown>>;
      };
      const rowOf = (k: string) => s.rows[k] as Record<string, unknown>;
      rowOf(key).mtmSl = bad;
      write(s);
      assert.throws(() => readAutomation(file), /mtmSl/);
    }
  });
});
