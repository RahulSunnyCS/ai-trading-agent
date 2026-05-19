import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Projects config: separate unit and integration so `bun run test:unit`
    // does not require Docker services (integration tests do).
    projects: [
      {
        test: {
          name: 'unit',
          // Include both M2's flat test layout (src/**/*.test.ts) and main's
          // __tests__ directory layout (src/**/__tests__/**/*.test.ts).
          include: [
            'src/**/*.test.ts',
            'src/**/__tests__/**/*.test.ts',
          ],
          // Exclude integration tests — they require Docker services.
          exclude: [
            'src/test/integration/**',
            'src/**/__tests__/**/*.integration.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'src/test/integration/**/*.test.ts',
            'src/**/__tests__/**/*.integration.test.ts',
          ],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Include all source files; exclude test files, type shims, and the
      // entry-point (src/index.ts) which is tested via integration tests only.
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/test/**',
        'src/types/**',
        'src/index.ts',
      ],
      // Emit both text summary and lcov for CI coverage reporting.
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
