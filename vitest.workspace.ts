/**
 * Vitest workspace — defines the two test projects that map to the two
 * package.json test scripts:
 *
 *   test:unit        → vitest run --project unit
 *   test:integration → vitest run --project integration
 *
 * The workspace file is required in vitest 2.x for `--project <name>`
 * filtering to work. Global settings (globals, environment, coverage) are
 * declared in vitest.config.ts and inherited by all projects here.
 *
 * Note: when vitest.workspace.ts is present, vitest uses it for project
 * discovery and the `test.projects` array in vitest.config.ts is ignored.
 * The inline projects in vitest.config.ts are kept as documentation of the
 * intended config structure; the workspace file is authoritative at runtime.
 */
export default [
  {
    test: {
      name: "unit",
      include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
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
];
