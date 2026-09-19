import { defineConfig } from 'vitest/config';

/**
 * Dashboard unit tests are pure-logic tests (src/lib/__tests__/*.test.ts) that
 * happen to work under the 'node' environment — no jsdom/happy-dom setup and
 * no React component tests exist yet. Split out from the server's vitest
 * config (apps/server/vitest.config.ts) as part of the monorepo migration:
 * these two test files previously ran under the root 'unit' project despite
 * src/frontend being excluded from the root tsconfig's typecheck.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/__tests__/**/*.test.ts'],
  },
});
