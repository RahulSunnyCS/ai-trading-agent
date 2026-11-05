import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  type Automation,
  type DayType,
  DayTypeUnknown,
  readAutomation,
  resolveAutomation,
} from './automation-settings.js';
import { automationForSession, loadDayType, sessionFor } from './day-type.js';

/** The cases shared with the Python and dashboard resolvers (BL-211). */
const CASES = JSON.parse(
  readFileSync(new URL('./fixtures/automation-rules-cases.json', import.meta.url), 'utf8'),
) as {
  base: object;
  cases: {
    name: string;
    rules: unknown[];
    dayType: DayType;
    error?: boolean;
    expect?: Record<string, { list: string; upload: boolean; rule: number | null }>;
  }[];
};

const dir = mkdtempSync(join(tmpdir(), 'broker-login-day-type-'));
const settings = (rules: unknown[]): Automation => {
  const file = join(dir, `s-${Math.random()}.json`);
  writeFileSync(file, JSON.stringify({ version: 3, ...CASES.base, rules }));
  return readAutomation(file);
};

describe('day-type rules (BL-211)', () => {
  for (const c of CASES.cases) {
    it(c.name, () => {
      const a = settings(c.rules);
      if (c.error) {
        assert.throws(() => resolveAutomation(a, c.dayType), DayTypeUnknown);
        return;
      }
      const resolved = resolveAutomation(a, c.dayType);
      for (const [key, want] of Object.entries(c.expect ?? {})) {
        const row = resolved.rows[key as keyof Automation['rows']];
        assert.deepEqual(
          { list: row.list, upload: row.upload },
          { list: want.list, upload: want.upload },
          key,
        );
      }
    });
  }

  it('no rules: the settings come back as they are', () => {
    const a = settings([]);
    assert.equal(resolveAutomation(a, CASES.cases[0]?.dayType as DayType), a);
  });

  it('a snapshot without rules reads as none', () => {
    const file = join(dir, 'old.json');
    writeFileSync(file, JSON.stringify({ version: 1, ...CASES.base }));
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    // .base has no rules key at all
    assert.equal(raw.rules, undefined);
    assert.deepEqual(readAutomation(file).rules, []);
  });

  it('a bad rule is an error, never a guess', () => {
    const bad = [
      { row: 'nope.finvasia', when: { kind: 'weekday', weekday: 'Fri' }, list: 'core' },
      { row: 'algotest.finvasia', when: { kind: 'weekday', weekday: 'Sat' }, list: 'core' },
      { row: 'algotest.finvasia', when: { kind: 'dte', index: 'NIFTY', dte: '8' }, list: 'core' },
      { row: 'algotest.finvasia', when: { kind: 'weekday', weekday: 'Fri' }, list: 'all' },
      { row: 'algotest.finvasia', list: 'core' },
    ];
    for (const rule of bad) assert.throws(() => settings([rule]), /rule 1/);
    const rule = {
      row: 'algotest.finvasia',
      when: { kind: 'weekday', weekday: 'Fri' },
      list: 'core',
    };
    assert.throws(() => settings(Array(21).fill(rule)), /more than 20/);
  });

  it('settings with no rule never ask for a day type', async () => {
    const a = settings([]);
    assert.equal(await automationForSession({ next: true }, a, {}), a);
  });

  it('a stored day type from the listed contracts is read without asking Python', async () => {
    const root = mkdtempSync(join(tmpdir(), 'broker-login-root-'));
    mkdirSync(join(root, 'rotation', 'day-type'), { recursive: true });
    const dt = {
      day: '2026-11-05',
      weekday: 'Thu',
      dte: { NIFTY: '2', SENSEX: '0' },
      source: 'master',
    };
    writeFileSync(join(root, 'rotation', 'day-type', '2026-11-05.json'), JSON.stringify(dt));
    assert.deepEqual(await loadDayType({ day: '2026-11-05' }, { TRADING_DATA_ROOT: root }), dt);
    const rule = {
      row: 'algotest.finvasia',
      when: { kind: 'dte', index: 'SENSEX', dte: '0' },
      list: 'core',
    };
    const resolved = await automationForSession({ day: '2026-11-05' }, settings([rule]), {
      TRADING_DATA_ROOT: root,
    });
    assert.equal(resolved.rows['algotest.finvasia'].list, 'core');
  });

  it('the evening jobs read the next session, everything else today', () => {
    assert.deepEqual(sessionFor(true), { next: true });
    const today = sessionFor(false);
    assert.ok('day' in today && /^\d{4}-\d{2}-\d{2}$/.test(today.day));
  });
});
