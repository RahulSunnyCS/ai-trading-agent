import { describe, expect, it } from 'vitest';

import type { MomentumSavedRun } from '../../types/momentum';
import { followedCount, isFollowed } from '../momentumFavourites';

function run(id: string, patch: Partial<MomentumSavedRun> = {}): MomentumSavedRun {
  return {
    id,
    created_at: '2026-10-08T10:00:00+0530',
    n: 1,
    name: id,
    config: { dataset: 'broad' },
    kpis: {},
    dates: [],
    strategy: [],
    overlay: false,
    favorite: false,
    active: false,
    status: null,
    group: null,
    member_of: null,
    ...patch,
  };
}

const group = run('g', { favorite: true, status: 'paper', group: ['a', 'b'], active: true });
const runs = [
  group,
  run('a', { favorite: true, member_of: 'g' }),
  run('b', { favorite: true, member_of: 'g' }),
  run('c', { favorite: true, status: 'invested' }),
  run('d', { favorite: true, status: 'watching' }),
  run('e'),
];

describe('favourite status', () => {
  it('counts a group once and its members not at all', () => {
    expect(followedCount(runs)).toBe(2);
    expect(isFollowed('watching')).toBe(false);
    expect(isFollowed(null)).toBe(false);
  });
});
