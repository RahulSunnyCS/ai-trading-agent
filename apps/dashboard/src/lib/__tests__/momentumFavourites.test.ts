import { describe, expect, it } from 'vitest';

import type { MomentumSavedRun } from '../../types/momentum';
import {
  filterCounts,
  followedCount,
  groupOf,
  isFollowed,
  matchesFilter,
} from '../momentumFavourites';

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

  it('filters and counts by status', () => {
    expect(runs.filter((r) => matchesFilter(r, 'paper')).map((r) => r.id)).toEqual(['g']);
    expect(runs.filter((r) => matchesFilter(r, 'favourites')).map((r) => r.id)).toEqual([
      'g',
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(filterCounts(runs)).toEqual({
      all: 6,
      favourites: 5,
      watching: 1,
      paper: 1,
      invested: 1,
    });
  });

  it("finds a member's group", () => {
    expect(groupOf(runs[1] as MomentumSavedRun, runs)?.id).toBe('g');
    expect(groupOf(runs[3] as MomentumSavedRun, runs)).toBeNull();
  });
});
