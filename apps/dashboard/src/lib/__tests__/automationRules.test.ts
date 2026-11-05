import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type AutomationSettings,
  type DayRule,
  type DayType,
  addRule,
  describeChanges,
  moveRule,
  removeRule,
  resolveRows,
  ruleSentence,
  ruleText,
  rulesProblems,
  updateRule,
  withDefaults,
  withRules,
} from '../automation';

/** The cases shared with the Python and broker-login resolvers (BL-211). */
const CASES = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../../../packages/broker-login/src/fixtures/automation-rules-cases.json',
    ),
    'utf8',
  ),
) as {
  base: Omit<AutomationSettings, 'rules'>;
  cases: {
    name: string;
    rules: DayRule[];
    dayType: DayType;
    error?: boolean;
    expect?: Record<string, { list: string; upload: boolean; rule: number | null }>;
  }[];
};

const settings = (rules: DayRule[]): AutomationSettings =>
  withDefaults({
    ...structuredClone(CASES.base),
    capital: { finvasia: 850_000, angelone: 850_000 },
    margin: { bufferPct: 10, days: 6 },
    rules,
  } as AutomationSettings);

const SX0: DayRule = {
  row: 'algotest.finvasia',
  when: { kind: 'dte', index: 'SENSEX', dte: '0' },
  list: 'core',
};

describe('day-type rules resolve as the jobs do (shared fixture)', () => {
  for (const c of CASES.cases) {
    it(c.name, () => {
      const resolved = resolveRows(settings(c.rules), c.dayType);
      if (c.error) {
        // the page marks the row it cannot decide; the jobs refuse the session
        const unknown = Object.values(resolved).filter((r) => r.unknown);
        expect(unknown.length).toBeGreaterThan(0);
        return;
      }
      for (const [key, want] of Object.entries(c.expect ?? {})) {
        const got = resolved[key as keyof typeof resolved];
        expect({ list: got.list, rule: got.rule }, key).toEqual({
          list: want.list,
          rule: want.rule,
        });
      }
    });
  }
});

describe('editing rules', () => {
  it('adds the owner’s first case, up to the limit', () => {
    const one = addRule(settings([]));
    expect(one.rules).toEqual([SX0]);
    let many = one;
    for (let i = 0; i < 30; i++) many = addRule(many);
    expect(many.rules).toHaveLength(20);
  });

  it('updates, moves and removes by position', () => {
    const a = settings([SX0, { ...SX0, row: 'algotest.angelone' }]);
    expect(updateRule(a, 1, { list: 't1' }).rules[1]?.list).toBe('t1');
    expect(moveRule(a, 1, -1).rules.map((r) => r.row)).toEqual([
      'algotest.angelone',
      'algotest.finvasia',
    ]);
    expect(moveRule(a, 0, -1)).toBe(a);
    expect(moveRule(a, 1, 1)).toBe(a);
    expect(removeRule(a, 0).rules).toHaveLength(1);
  });

  it('an emptied note is no note', () => {
    const a = updateRule(settings([SX0]), 0, { note: 'why' });
    expect(a.rules[0]?.note).toBe('why');
    expect(updateRule(a, 0, { note: '' }).rules[0]).toEqual(SX0);
  });

  it('refuses a rule an earlier one already covers, as the scheduler does', () => {
    expect(rulesProblems([SX0, { ...SX0, list: 'none' }])).toEqual([
      'Rule 2 can never apply: rule 1 tests the same thing on the same row and is tried first.',
    ]);
    expect(rulesProblems([SX0, { ...SX0, row: 'algotest.angelone' }])).toEqual([]);
    expect(rulesProblems([SX0, { ...SX0, when: { kind: 'weekday', weekday: 'Thu' } }])).toEqual([]);
  });
});

describe('saying rules in words', () => {
  it('a rule as a line and as a sentence', () => {
    expect(ruleText(SX0)).toBe('AlgoTest · Shoonya on SENSEX 0 DTE → Adaptive Classic');
    expect(ruleSentence(SX0, settings([SX0]))).toBe(
      'On a day SENSEX has 0 weekdays to expiry, AlgoTest · Shoonya trades Adaptive Classic instead of its own list (Adaptive Tuned).',
    );
    const friday: DayRule = {
      row: 'quantiply.angelone',
      when: { kind: 'weekday', weekday: 'Fri' },
      list: 'none',
    };
    expect(ruleSentence(friday, settings([friday]))).toBe(
      'On a day it is a Friday, Quantiply · Angel One trades nothing instead of its own list (Adaptive Classic).',
    );
  });

  it('describes rules added, removed and reordered', () => {
    const none = settings([]);
    const f: DayRule = {
      row: 'quantiply.angelone',
      when: { kind: 'weekday', weekday: 'Fri' },
      list: 'none',
    };
    expect(describeChanges(none, settings([SX0]))).toEqual([
      'Rule added: AlgoTest · Shoonya on SENSEX 0 DTE → Adaptive Classic',
    ]);
    expect(describeChanges(settings([SX0, f]), settings([f]))).toEqual([
      'Rule removed: AlgoTest · Shoonya on SENSEX 0 DTE → Adaptive Classic',
    ]);
    expect(describeChanges(settings([SX0, f]), settings([f, SX0]))).toEqual(['Rules reordered']);
    expect(describeChanges(settings([SX0]), settings([{ ...SX0, note: 'expiry' }]))).toEqual([
      'Rule removed: AlgoTest · Shoonya on SENSEX 0 DTE → Adaptive Classic',
      'Rule added: AlgoTest · Shoonya on SENSEX 0 DTE → Adaptive Classic (expiry)',
    ]);
    expect(describeChanges(none, withRules(none, []))).toEqual([]);
  });

  it('settings from a scheduler that predates rules read as none', () => {
    const old = structuredClone(settings([])) as unknown as { rules?: unknown };
    old.rules = undefined;
    expect(withDefaults(old as AutomationSettings).rules).toEqual([]);
  });
});
