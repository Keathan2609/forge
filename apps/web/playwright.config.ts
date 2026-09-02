import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for the console.
 *
 * These run against a *live* stack — a real API, real workers, real PostgreSQL — because
 * the console's whole job is to show what the system is actually doing. A test suite
 * with a mocked API would verify that the mock renders, which is not the property worth
 * protecting.
 *
 * Start the stack first:
 *   pnpm forge:dev && pnpm demo:seed
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Serial: several specs trigger real runs, and parallel workers competing for the same
  // fleet makes assertions about worker allocation meaningless.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Assumes the stack is already running. Starting it from here would hide the fact that
  // these tests need real infrastructure, and make a missing database look like a
  // Playwright problem.
  webServer: undefined,
});
