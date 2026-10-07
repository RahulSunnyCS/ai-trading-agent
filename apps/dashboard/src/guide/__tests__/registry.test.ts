import { describe, expect, it } from 'vitest';

import { NAV_GROUPS, navItem } from '../../components/shell/nav';
import { parsePath } from '../../lib/routes';
import { GLOSSARY, glossaryEntry } from '../glossary';
import {
  GUIDE_CHAPTERS,
  GUIDE_PAGES,
  guidePageByRef,
  guidePageForScreen,
  guidePath,
  resolveGuidePage,
  searchGuide,
} from '../registry';

/** Every `[text](scheme:target)` link in a page, as [scheme, target]. */
function guideLinks(body: string): Array<[string, string]> {
  return [...body.matchAll(/\]\((app|guide|glossary):([^)\s]+)\)/g)].map((m) => [m[1]!, m[2]!]);
}

describe('guide registry', () => {
  it('has the same chapters, in the same order, as the Guide nav item', () => {
    const children = navItem('guide')?.children?.map((c) => c.segment);
    expect(children).toEqual(GUIDE_CHAPTERS.map((c) => c.id));
  });

  it('gives every page a unique path, a body and a summary', () => {
    const paths = GUIDE_PAGES.map(guidePath);
    expect(new Set(paths).size).toBe(paths.length);
    for (const page of GUIDE_PAGES) {
      expect(page.body.trim().length, page.slug).toBeGreaterThan(100);
      expect(page.summary.length, page.slug).toBeGreaterThan(10);
    }
  });

  it('keeps pages in chapter order', () => {
    const order = GUIDE_CHAPTERS.map((c) => c.id as string);
    const indexes = GUIDE_PAGES.map((p) => order.indexOf(p.chapter));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(indexes).not.toContain(-1);
  });

  it('points every documented screen at a real route', () => {
    for (const page of GUIDE_PAGES) {
      if (!page.screen) continue;
      const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === page.screen?.tab);
      expect(item, page.slug).toBeDefined();
      const first = page.screen.rest?.[0];
      if (first && item?.children) {
        expect(
          item.children.some((c) => c.segment === first),
          `${page.slug}: ${first}`,
        ).toBe(true);
      }
    }
  });

  it('resolves every link inside every page', () => {
    for (const page of GUIDE_PAGES) {
      for (const [scheme, target] of guideLinks(page.body)) {
        const where = `${page.chapter}/${page.slug} -> ${scheme}:${target}`;
        if (scheme === 'glossary') expect(glossaryEntry(target), where).toBeDefined();
        if (scheme === 'guide') expect(guidePageByRef(target), where).toBeDefined();
        if (scheme === 'app') expect(parsePath(target).tab, where).not.toBeNull();
      }
    }
  });

  it('has glossary entries with unique ids and valid see-also links', () => {
    const ids = GLOSSARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of GLOSSARY) {
      expect(entry.short.length, entry.id).toBeGreaterThan(10);
      for (const other of entry.seeAlso ?? []) expect(glossaryEntry(other), entry.id).toBeDefined();
    }
  });

  it('keeps internal references out of the text readers see', () => {
    const text = [
      ...GUIDE_PAGES.map((p) => p.body),
      ...GLOSSARY.map((e) => e.short + (e.long ?? '')),
    ];
    for (const t of text) {
      expect(t).not.toMatch(/\bBL-\d+/);
      expect(t).not.toMatch(/\bTODO\b/);
    }
  });
});

describe('guide routing helpers', () => {
  it('opens a bare chapter on its first page and flags it as not canonical', () => {
    const { page, exact } = resolveGuidePage(['momentum']);
    expect(page.chapter).toBe('momentum');
    expect(page.slug).toBe('how-it-works');
    expect(exact).toBe(false);
  });

  it('opens an unknown path on the first page', () => {
    const { page, exact } = resolveGuidePage(['nope', 'nothing']);
    expect(page).toBe(GUIDE_PAGES[0]);
    expect(exact).toBe(false);
  });

  it('recognises an exact page path', () => {
    const { page, exact } = resolveGuidePage(['optionslab', 'runs']);
    expect(page.slug).toBe('runs');
    expect(exact).toBe(true);
  });

  it('finds the page for a screen, preferring the most specific one', () => {
    expect(guidePageForScreen('optionslab', ['builder'])?.slug).toBe('builder-form');
    expect(guidePageForScreen('optionslab', ['builder', 'yaml'])?.slug).toBe('builder-yaml');
    expect(guidePageForScreen('momentum', ['journal'])?.slug).toBe('journal');
    expect(guidePageForScreen('jobs')?.slug).toBe('jobs');
    expect(guidePageForScreen('live')).toBeUndefined();
  });

  it('gives every Momentum and Options Lab sub-screen a page', () => {
    for (const tab of ['momentum', 'optionslab'] as const) {
      for (const child of navItem(tab)?.children ?? []) {
        expect(guidePageForScreen(tab, [child.segment]), `${tab}/${child.segment}`).toBeDefined();
      }
    }
  });

  it('searches titles, summaries and text, requiring every word', () => {
    expect(searchGuide('journal').map((p) => p.slug)).toContain('journal');
    expect(searchGuide('zzzznotaword')).toEqual([]);
    expect(searchGuide('')).toHaveLength(GUIDE_PAGES.length);
  });

  it("does not match the link syntax inside pages ('app', 'guide', 'glossary')", () => {
    // Every page links with (app:/…), (guide:…) or (glossary:…); those are not text a reader sees.
    for (const word of ['app:', 'guide:', 'glossary:']) {
      expect(searchGuide(word), word).toEqual([]);
    }
    // The text of a link still counts.
    expect(searchGuide('drawdown').length).toBeGreaterThan(0);
  });
});
