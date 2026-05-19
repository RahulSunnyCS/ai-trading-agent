import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    projects: [
      {
        test: {
          name: "unit",
          // Include both flat test files and __tests__ subdirectory convention.
          // The milestones-0-1 branch uses src/**/*.test.ts; the payment branch
          // uses src/**/__tests__/**/*.test.ts.  Both patterns are included so
          // `bun run test:unit` picks up tests from either convention.
          include: [
            "src/**/*.test.ts",
            "src/**/__tests__/**/*.test.ts",
          ],
          // Exclude integration tests from the unit project so that
          // `bun run test:unit` does not require Docker services to be running.
          exclude: [
            "src/test/integration/**",
            "src/**/__tests__/**/*.integration.test.ts",
          ],
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "src/test/integration/**/*.test.ts",
            "src/**/__tests__/**/*.integration.test.ts",
          ],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/__tests__/**",
        "src/test/**",
        "src/types/**",
        "src/index.ts",
      ],
      // Output HTML report to coverage/ so it can be inspected in a browser
      // without committing the output (coverage/ is gitignored).
      reportsDirectory: "coverage",
    },
  },
});
