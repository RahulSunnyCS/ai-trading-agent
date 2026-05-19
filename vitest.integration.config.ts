import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.integration.test.ts'],
    testTimeout: 30_000, // integration tests can be slow
    hookTimeout: 30_000,
  },
});
