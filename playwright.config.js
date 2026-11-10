import { defineConfig } from '@playwright/test';

// Browser tests for the pages. Supabase is replaced by an in-memory fake
// (e2e/fake-supabase.js), so they never touch the real project.
// They use the installed Google Chrome (preinstalled on GitHub's runners); set
// PW_CHANNEL=chromium after `npx playwright install chromium` to use that instead.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.js',
  timeout: 20_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    channel: process.env.PW_CHANNEL ?? 'chrome',
    serviceWorkers: 'block',
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/static-server.js',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
});
