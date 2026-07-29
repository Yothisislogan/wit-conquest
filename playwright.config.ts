import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['line']] : [['list']],
  timeout: 45_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    // Every gameplay assertion in this suite is expressed through taps, so the
    // default project runs with touch emulation enabled.
    hasTouch: true,
  },
  projects: [
    {
      name: 'mobile-portrait',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'mobile-small',
      // Approximates an iPhone SE: the tightest layout we support.
      use: {
        ...devices['iPhone SE'],
        viewport: { width: 320, height: 568 },
      },
    },
    {
      name: 'tablet',
      use: { ...devices['iPad (gen 7)'] },
    },
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'], hasTouch: false },
    },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
