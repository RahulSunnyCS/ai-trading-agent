import { describe, expect, it } from 'vitest';

import type { PlanAccount, RotationPlan } from '../../types/rotationPlan';
import { extraLines, pickChips, sessionOf, settingsOf } from '../rotationPlanView';

const angel: PlanAccount = {
  platform: 'quantiply',
  broker: 'angelone',
  label: 'Quantiply · Angel One',
  book: 'core',
  state: {
    '2026-10-27': {
      uploaded: ['N_ditm1_0947', 'N_p80_1202'],
      enabled: ['N_ditm1_0947'],
      held: [],
      deploys_known: true,
      extra: [],
    },
    '2026-10-28': {
      uploaded: ['N_ditm1_0947', 'S_p250_1317'],
      enabled: [],
      held: ['N_ditm1_0947', 'S_p250_1317'],
      deploys_known: true,
      extra: ['S_p250_1317'],
    },
  },
};

const plan: RotationPlan = {
  sessions: [
    {
      day: '2026-10-27',
      kind: 'recorded',
      books: {
        core: [
          {
            name: 'N_ditm1_0947',
            role: 'core',
            start: '09:47',
            head: 'N_dir_ITM1',
            params: 'SL21%',
          },
        ],
      },
    },
    { day: '2026-10-28', kind: 'tentative', sent_on: '2026-10-27', books: { core: [] } },
  ],
  accounts: [
    angel,
    {
      platform: 'quantiply',
      broker: 'finvasia',
      label: 'Quantiply · Shoonya',
      book: 't1',
      state: { error: 'no upload ledger for this account yet' },
    },
  ],
  settings: 'settings v6',
  paused_until: null,
};

describe('pickChips', () => {
  it('says on, uploaded and not uploaded, per account that uploads the book', () => {
    expect(pickChips(plan, 'core', '2026-10-27', 'N_ditm1_0947', 'recorded')[0]).toMatchObject({
      text: 'was on',
      tone: 'positive',
    });
    expect(pickChips(plan, 'core', '2026-10-27', 'N_p80_1202', 'recorded')[0]).toMatchObject({
      text: 'uploaded',
    });
    expect(pickChips(plan, 'core', '2026-10-28', 'S_p320_1302', 'tentative')[0]).toMatchObject({
      text: 'not uploaded',
      tone: 'warning',
    });
  });

  it('says a missing ledger, never "not uploaded", and leaves other books out', () => {
    const chips = pickChips(plan, 't1', '2026-10-28', 'X', 'tentative');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.text).toBe('no ledger');
  });
});

describe('the rest', () => {
  it('names algos held for the weekday that nobody picked', () => {
    expect(extraLines(plan, 'core', '2026-10-28')).toEqual([
      'Quantiply · Angel One also holds S_p250_1317 for Wed: not picked; it trades only if switched on.',
    ]);
    expect(extraLines(plan, 'core', '2026-10-27')).toEqual([]);
  });

  it('finds sessions and a pick’s settings', () => {
    const s = sessionOf(plan, 'recorded');
    expect(settingsOf(s, 'core', 'N_ditm1_0947')?.params).toBe('SL21%');
    expect(settingsOf(s, 't1', 'N_ditm1_0947')).toBeNull();
    expect(sessionOf(null, 'tentative')).toBeNull();
  });
});
