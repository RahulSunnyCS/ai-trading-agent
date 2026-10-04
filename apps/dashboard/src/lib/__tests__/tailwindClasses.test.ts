/**
 * Compiles Tailwind over src/** and fails on any utility-shaped class that emits no CSS.
 *
 * Tailwind drops an unknown class silently, so a typo such as `bg-positive/12` (12 is not on
 * the opacity scale), `bg-surface-1` or `text-danger` (not tokens) ships as a class with no
 * style behind it. This test catches that at unit-test time.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { describe, expect, it } from 'vitest';

import config from '../../../tailwind.config';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Utility families whose value is a theme token, where a wrong name compiles to nothing. */
const PREFIXES = [
  'bg',
  'text',
  'border',
  'ring',
  'ring-offset',
  'shadow',
  'from',
  'via',
  'to',
  'divide',
  'outline',
  'fill',
  'stroke',
  'decoration',
  'accent',
  'caret',
  'placeholder',
  'rounded',
  'font',
  'opacity',
  'animate',
];
const UTILITY = new RegExp(
  `^(?:[a-z0-9-]+:|\\[[^\\]]+\\]:)*!?-?(?:${PREFIXES.join('|')})-[^\\s]+$`,
);

/** Strings in src that have a utility's shape but are not class names. */
const NOT_CLASSES = new Set<string>(['text-anchor', 'font-family', 'font-size', 'font-weight']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Every utility-shaped token in the source, mapped to the first file that uses it. */
function candidates(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    for (const token of readFileSync(file, 'utf8').split(/[\s"'`]+/)) {
      // A token with interpolation (`bg-${tone}`) is not a literal class.
      if (/[${}()<>=,;]/.test(token) || !UTILITY.test(token) || NOT_CLASSES.has(token)) continue;
      if (!found.has(token)) found.set(token, relative(SRC, file));
    }
  }
  return found;
}

async function compiledClasses(tokens: string[]): Promise<Set<string>> {
  const css = readFileSync(join(SRC, 'index.css'), 'utf8');
  const result = await postcss([
    tailwindcss({ ...config, content: [{ raw: tokens.join(' '), extension: 'html' }] }),
  ]).process(css, { from: join(SRC, 'index.css') });
  const classes = new Set<string>();
  result.root.walkRules((rule) => {
    for (const match of rule.selector.matchAll(/\.((?:\\.|[\w-])+)/g)) {
      classes.add((match[1] ?? '').replace(/\\(.)/g, '$1'));
    }
  });
  return classes;
}

describe('Tailwind classes in src/**', () => {
  it('every utility-shaped class compiles to CSS', async () => {
    const found = candidates();
    expect(found.size).toBeGreaterThan(100);
    const compiled = await compiledClasses([...found.keys()]);
    const missing = [...found]
      .filter(([token]) => !compiled.has(token))
      .map(([token, file]) => `${token}  (${file})`);
    expect(missing).toEqual([]);
  }, 30_000);

  it('catches the classes this test was written for', async () => {
    const bad = ['bg-positive/12', 'bg-warning/14', 'bg-primary/8', 'bg-surface-1', 'text-danger'];
    const compiled = await compiledClasses([...bad, 'bg-positive/10']);
    expect(bad.filter((token) => compiled.has(token))).toEqual([]);
    expect(compiled.has('bg-positive/10')).toBe(true);
  }, 30_000);
});
