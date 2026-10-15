import { describe, expect, it } from 'vitest';

import { sidebarChildren } from '../Sidebar';
import type { NavChild } from '../nav';

const kids: NavChild[] = [
  { segment: 'a', label: 'A', group: 'One' },
  { segment: 'b', label: 'B', group: 'One' },
  { segment: 'c', label: 'C', group: 'Two' },
  { segment: 'h', label: 'H', group: 'Two', hidden: true },
  { segment: 'plain', label: 'Plain' },
];

describe('sidebarChildren', () => {
  it('puts a heading above the first child of each group only', () => {
    const rows = sidebarChildren(kids, kids[0]);
    expect(rows.map((r) => [r.child.segment, r.heading])).toEqual([
      ['a', 'One'],
      ['b', null],
      ['c', 'Two'],
      ['plain', null],
    ]);
  });

  it('leaves a hidden child out unless it is the page being shown', () => {
    expect(sidebarChildren(kids, kids[0]).map((r) => r.child.segment)).not.toContain('h');
    expect(sidebarChildren(kids, kids[3]).map((r) => r.child.segment)).toContain('h');
  });
});
