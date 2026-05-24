/**
 * Playwright configuration for the AI Trading Agent dashboard E2E suite.
 *
 * Base URL: the Vite dev server at http://localhost:5173.
 * The webServer block is NOT used — starting Vite (and its proxied Fastify
 * backend) requires environment credentials and a running DB/Redis stack,
 * which is not available in every CI environment.  CI operators should start
 * the Vite dev server separately before running the suite.
 *
 * All tests use route interception (page.route()) to mock backend responses
 * so the suite is fully deterministic without a running API server.  The Vite
 * dev server itself (the React SPA shell) is the only process the tests need.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',

  // Fail the test if it takes longer than 30 s — this prevents a hung test
  // from blocking CI indefinitely.
  timeout: 30_000,

  // Parallelism: run files in parallel; tests within a file run serially.
  // Each test sets up its own state via route interception, so parallel
  // file-level execution is safe.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,

  // No automatic retries — a flaky test should be fixed, not silently retried.
  retries: process.env.CI ? 1 : 0,

  reporter: 'list',

  use: {
    // The Vite dev server for the React SPA.
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',

    // Capture a trace on the first retry — useful for post-mortem debugging in
    // CI without recording on every passing run.
    trace: 'on-first-retry',

    // Short action timeout so a missing element fails fast rather than hanging.
    actionTimeout: 10_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
