import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          // Exclude integration tests from the unit project so that
          // `bun run test:unit` does not require Docker services to be running.
          exclude: ["src/test/integration/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/test/integration/**/*.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Output HTML report to coverage/ so it can be inspected in a browser
      // without committing the output (coverage/ is gitignored).
      reportsDirectory: "coverage",
    },
  },
});
