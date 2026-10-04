import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import nextConfig from '../../../next.config';

/**
 * Under MOMENTUM_DIRECT (docs/remote-dashboard.md) no Fastify server sits behind the dashboard,
 * so an /api/momentum path without its own direct rule falls through to the catch-all /api
 * rewrite and fails. Scanning the source for /api/momentum literals means a new endpoint can't
 * ship without its rule (favorite-strategies once did).
 */
const SRC = fileURLToPath(new URL('../../', import.meta.url));
const MOMENTUM_LITERAL = /['"`](\/api\/momentum\/[^'"`?]*)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
  });
}

function calledMomentumPaths(): string[] {
  const paths = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    for (const match of readFileSync(file, 'utf8').matchAll(MOMENTUM_LITERAL)) {
      const literal = match[1];
      // `${id}` as a whole segment stands for a value; anywhere else (a query suffix) drop it.
      if (literal) paths.add(literal.replace(/\/\$\{[^}]*\}/g, '/x').replace(/\$\{[^}]*\}/g, ''));
    }
  }
  return [...paths].sort();
}

/** A rewrite `source` (`:name` = one segment, `:name*` = the rest) as an anchored RegExp. */
function sourcePattern(source: string): RegExp {
  const body = source
    .split('/')
    .map((part) => {
      if (/^:\w+\*$/.test(part)) return '.*';
      if (/^:\w+$/.test(part)) return '[^/]+';
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${body}$`);
}

describe('MOMENTUM_DIRECT rewrites', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('route every /api/momentum path the dashboard calls', async () => {
    vi.stubEnv('MOMENTUM_DIRECT', '1');
    const rewrites = await nextConfig.rewrites?.();
    if (!Array.isArray(rewrites)) throw new Error('next.config rewrites() should return an array');
    const direct = rewrites
      .filter((rule) => rule.source.startsWith('/api/momentum/'))
      .map((rule) => sourcePattern(rule.source));

    const called = calledMomentumPaths();
    expect(called).toContain('/api/momentum/favorite-strategies'); // the scan itself works
    expect(called.filter((path) => !direct.some((pattern) => pattern.test(path)))).toEqual([]);
  });
});
