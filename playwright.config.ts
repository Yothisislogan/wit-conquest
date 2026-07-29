import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * Only Chromium is provisioned in this environment, so the phone and tablet
 * projects borrow the device metrics (viewport, DPR, touch, user agent) but run
 * on Chromium. Safari and Firefox passes are manual — see docs/TESTING.md.
 *
 * PLAYWRIGHT_CHROMIUM_PATH points at a pre-installed browser when the image
 * ships one that does not match this Playwright build's expected revision.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

const asChromium = (device: (typeof devices)[string]) => ({
  ...device,
  defaultBrowserType: 'chromium' as const,
  browserName: 'chromium' as const,
  launchOptions: executablePath ? { executablePath } : {},
});

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [['line']] : [['list']],
  timeout: 60_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    // Every gameplay assertion in this suite is expressed through taps, so the
    // default projects run with touch emulation enabled.
    hasTouch: true,
  },
  projects: [
    {
      name: 'mobile-portrait',
      use: asChromium(devices['Pixel 7']),
    },
    {
      name: 'mobile-small',
      // iPhone SE metrics: the tightest layout the game supports.
      use: asChromium(devices['iPhone SE']),
    },
    {
      name: 'tablet',
      use: asChromium(devices['iPad (gen 7)']),
    },
    {
      name: 'desktop-chrome',
      use: {
        ...devices['Desktop Chrome'],
        hasTouch: false,
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
