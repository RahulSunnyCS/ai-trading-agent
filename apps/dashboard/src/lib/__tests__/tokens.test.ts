/**
 * Contrast checks on the design tokens in index.css, so a token edit cannot quietly drop
 * body, label or timestamp text below WCAG AA (4.5:1).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.css'),
  'utf8',
);

function block(selector: string): Record<string, [number, number, number]> {
  const start = CSS.indexOf(`${selector} {`);
  const body = CSS.slice(start, CSS.indexOf('\n  }', start));
  const tokens: Record<string, [number, number, number]> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/g)) {
    tokens[m[1] as string] = [Number(m[2]), Number(m[3]) / 100, Number(m[4]) / 100];
  }
  return tokens;
}

function luminance([h, s, l]: [number, number, number]): number {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe.each([
  ['light', ':root'],
  ['dark', '.dark'],
])('%s theme tokens', (_name, selector) => {
  const t = block(selector);

  it('defines the text, surface and series tokens', () => {
    for (const name of ['background', 'surface', 'foreground', 'muted', 'faint', 'primary']) {
      expect(t[name], name).toBeDefined();
    }
    for (const n of [1, 2, 3, 4]) expect(t[`series-${n}`], `series-${n}`).toBeDefined();
  });

  it.each(['foreground', 'muted', 'faint'])(
    '%s text passes AA on background and surface',
    (text) => {
      for (const ground of ['background', 'surface'] as const) {
        const ratio = contrast(
          t[text] as [number, number, number],
          t[ground] as [number, number, number],
        );
        expect(ratio, `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('primary-foreground passes AA on primary', () => {
    const ratio = contrast(
      t['primary-foreground'] as [number, number, number],
      t.primary as [number, number, number],
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
