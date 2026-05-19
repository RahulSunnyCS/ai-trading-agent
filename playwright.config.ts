import { defineConfig } from "@playwright/test";

/**
 * Playwright configuration for E2E tests targeting the Fastify REST API
 * (port 3000). These are API-level tests using the `request` fixture, not
 * browser navigation tests.
 *
 * baseURL is set to the API server. Tests use relative paths like
 * `/personalities` which resolve against this base.
 *
 * webServer:
 *   - In local dev (CI=undefined) Playwright starts `bun run sim` automatically
 *     before running tests and waits for the server to respond on port 3000.
 *   - In CI the server is started separately (Docker services + migrations must
 *     already be running); set CI=true to skip the webServer block.
 *
 * Required environment variables (see e2e/*.spec.ts for per-file docs):
 *   BASE_URL        — override API base URL (default: http://localhost:3000)
 *   CI              — set to any truthy value in CI to skip the webServer block
 *   SIMULATE        — passed through to `bun run dev`; defaults to true here
 */
export default defineConfig({
  testDir: "./e2e",

  // Run tests sequentially by default — API tests can share database state,
  // and full parallelism risks race conditions in cleanup. Workers can be
  // increased once test isolation is verified.
  workers: 1,

  // Retry once on failure to distinguish flakiness from genuine failures.
  retries: 1,

  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    // API tests do not need a browser viewport.
    // The `request` fixture is used directly.
  },

  projects: [
    {
      name: "api",
      // No browser specified — these are pure API tests using the
      // Playwright request fixture (APIRequestContext), not a browser.
      use: {},
    },
  ],

  // Only start a dev server when NOT running in CI.
  // CI starts the server separately (with real DB + Redis) before running tests.
  ...(process.env.CI
    ? {}
    : {
        webServer: {
          command: "SIMULATE=true bun run dev",
          url: "http://localhost:3000/health",
          reuseExistingServer: true,
          timeout: 60_000,
        },
      }),
});
