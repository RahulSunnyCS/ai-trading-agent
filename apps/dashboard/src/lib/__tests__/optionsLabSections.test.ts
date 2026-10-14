import { describe, expect, it } from 'vitest';

import { NAV_GROUPS } from '../../components/shell/nav';
import { SECTION_META } from '../optionsLabSections';
import { OPTIONS_LAB_SECTIONS } from '../routes';

const children = () =>
  NAV_GROUPS.flatMap((group) => group.items).find((item) => item.id === 'optionslab')?.children ??
  [];

describe('Options Lab section metadata', () => {
  it('has a question and an explanation for every section', () => {
    for (const section of OPTIONS_LAB_SECTIONS) {
      const meta = SECTION_META[section];
      expect(meta, section).toBeDefined();
      expect(meta.question.endsWith('?'), section).toBe(true);
      expect(meta.explanation.length, section).toBeGreaterThan(20);
    }
  });

  it('agrees with the sidebar about which workspace a section is in', () => {
    for (const child of children()) {
      const meta = SECTION_META[child.segment as keyof typeof SECTION_META];
      expect(child.group, child.segment).toBe(meta.workspace);
    }
  });

  it('lists Today first and keeps each workspace together', () => {
    const groups = children().map((child) => child.group);
    expect(groups[0]).toBe('Today');
    // A workspace never re-appears after another one started.
    const seen: string[] = [];
    for (const group of groups) {
      if (seen[seen.length - 1] !== group) {
        expect(seen, String(group)).not.toContain(group);
        seen.push(String(group));
      }
    }
    expect(seen).toEqual(['Today', 'Explore data', 'Build and test']);
  });

  it('lists every section in the sidebar, and no retired one', () => {
    expect(children().some((child) => child.hidden)).toBe(false);
    expect(children().map((child) => child.segment)).not.toContain('results');
  });
});
