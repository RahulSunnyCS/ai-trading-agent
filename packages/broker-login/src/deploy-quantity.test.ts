import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copyOf, deployList, placements, staleExport } from './deploy-quantity.js';

// 2026-11-06's real split export (NIFTY 1 DTE, SENSEX 4 DTE), settings v13
const strategies = [
  'T1 · N_wide-t1s4_1002',
  'T1 · N_wide-t1s4_1002 · ×2',
  'T1 · N_ditm1_0947',
  'T1 · N_ditm1_0947 · ×2',
  'T1 · N_p80_1002',
  'T1 · N_p80_1002 · ×2',
].map((name) => ({ name }));
const split = {
  strategies,
  split: 'BL-209',
  accounts: {
    finvasia: ['T1 · N_wide-t1s4_1002 · ×2', 'T1 · N_ditm1_0947 · ×2'],
    angelone: ['T1 · N_ditm1_0947', 'T1 · N_p80_1002 · ×2'],
  },
  alone: {
    finvasia: ['T1 · N_wide-t1s4_1002', 'T1 · N_ditm1_0947 · ×2', 'T1 · N_p80_1002'],
    angelone: ['T1 · N_wide-t1s4_1002', 'T1 · N_ditm1_0947', 'T1 · N_p80_1002'],
  },
};

describe('copyOf', () => {
  it('splits a copy name into its one-lot name and its lots', () => {
    assert.deepEqual(copyOf('T1 · N_x_1002 · ×2'), { base: 'T1 · N_x_1002', lots: 2 });
    assert.deepEqual(copyOf('T1 · N_x_1002'), { base: 'T1 · N_x_1002', lots: 1 });
    assert.deepEqual(copyOf('T1 · N_x_1002 · add-on · ×3'), {
      base: 'T1 · N_x_1002 · add-on',
      lots: 3,
    });
  });
});

describe('placements', () => {
  it("a split export: the one-lot strategy on each account at that account's quantity", () => {
    const p = placements(split, strategies, ['finvasia', 'angelone']);
    assert.equal(p.problem, null);
    assert.deepEqual(p.byBroker.get('finvasia'), [
      { name: 'T1 · N_wide-t1s4_1002', lots: 2 },
      { name: 'T1 · N_ditm1_0947', lots: 2 },
    ]);
    assert.deepEqual(p.byBroker.get('angelone'), [
      { name: 'T1 · N_ditm1_0947', lots: 1 },
      { name: 'T1 · N_p80_1002', lots: 2 },
    ]);
    const d = deployList(p.byBroker);
    assert.deepEqual(d.names, ['T1 · N_wide-t1s4_1002', 'T1 · N_ditm1_0947', 'T1 · N_p80_1002']);
    assert.deepEqual(d.lots.get('T1 · N_ditm1_0947'), { finvasia: 2, angelone: 1 });
    assert.deepEqual(d.lots.get('T1 · N_p80_1002'), { angelone: 2 });
  });

  it('one account trading alone takes the layout where it trades everything', () => {
    const p = placements(split, strategies, ['angelone']);
    assert.deepEqual(p.byBroker.get('angelone'), [
      { name: 'T1 · N_wide-t1s4_1002', lots: 1 },
      { name: 'T1 · N_ditm1_0947', lots: 1 },
      { name: 'T1 · N_p80_1002', lots: 1 },
    ]);
  });

  it('a copy with no one-lot strategy is deployed as it is, at 1', () => {
    const only = strategies.filter((s) => s.name !== 'T1 · N_p80_1002');
    const p = placements(split, only, ['finvasia', 'angelone']);
    assert.deepEqual(p.byBroker.get('angelone')?.at(-1), { name: 'T1 · N_p80_1002 · ×2', lots: 1 });
  });

  it('an add-on the morning rule left out is skipped, a name the export lacks is a problem', () => {
    const withAddon = {
      ...split,
      strategies: [...strategies, { name: 'T1 · N_p80_1002 · add-on' }],
      accounts: {
        ...split.accounts,
        finvasia: [...split.accounts.finvasia, 'T1 · N_p80_1002 · add-on'],
      },
    };
    const kept = strategies; // the add-on left out
    const p = placements(withAddon, kept, ['finvasia', 'angelone']);
    assert.equal(p.problem, null);
    assert.equal(p.byBroker.get('finvasia')?.length, 2);
    const ghost = { ...split, accounts: { ...split.accounts, angelone: ['T1 · N_ghost_0930'] } };
    assert.match(placements(ghost, strategies, ['finvasia', 'angelone']).problem ?? '', /N_ghost/);
  });

  it('a split export with no list for an uploading account is a problem', () => {
    const p = placements(
      { ...split, accounts: { finvasia: split.accounts.finvasia } },
      strategies,
      ['finvasia', 'angelone'],
    );
    assert.match(p.problem ?? '', /no list for angelone/);
  });

  it('an export that is not split: every strategy on every uploading account at 1', () => {
    const plain = { strategies: strategies.slice(0, 1) };
    const p = placements(plain, plain.strategies, ['finvasia', 'angelone']);
    const d = deployList(p.byBroker);
    assert.deepEqual(d.lots.get('T1 · N_wide-t1s4_1002'), { finvasia: 1, angelone: 1 });
  });
});

describe('staleExport', () => {
  it('passes only an export made under the settings now in force', () => {
    assert.equal(staleExport(13, 13), null);
    assert.match(staleExport(12, 13) ?? '', /under settings v12.*now v13.*nothing activated/);
    assert.match(staleExport(undefined, 13) ?? '', /no settings version/);
  });
});
