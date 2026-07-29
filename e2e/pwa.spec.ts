import { expect, test } from '@playwright/test';
import { board, pieces, press } from './helpers.ts';

test.describe('installable and offline', () => {
  test('serves a valid web app manifest with real icons', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      /manifest\.webmanifest$/,
    );

    const response = await request.get('/manifest.webmanifest');
    expect(response.ok()).toBe(true);
    const manifest = JSON.parse(await response.text());

    expect(manifest.name).toBe('Monster Territory');
    expect(manifest.display).toBe('standalone');
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);

    for (const icon of manifest.icons as Array<{ src: string; sizes: string }>) {
      const asset = await request.get(icon.src.replace(/^\.\//, '/'));
      expect(asset.ok(), `${icon.src} is served`).toBe(true);
      expect((await asset.body()).byteLength, `${icon.src} is not a stub`).toBeGreaterThan(1000);
    }
  });

  test('declares a theme colour and an apple touch icon', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute(
      'content',
      /#[0-9a-f]{6}/i,
    );
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', /\.png$/);
  });

  test('registers a service worker and then plays with the network cut', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => navigator.serviceWorker?.controller !== null,
      undefined,
      { timeout: 20_000 },
    );

    // Warm the cache with the assets a cold start needs, then pull the plug.
    await press(page.getByRole('button', { name: 'Play Game' }));
    await expect(board(page).locator('.cell')).toHaveCount(61);
    await page.waitForTimeout(500);

    await context.setOffline(true);
    await page.reload();

    await expect(page.getByRole('heading', { name: /monster\s*territory/i })).toBeVisible();
    await press(page.getByRole('button', { name: 'Play Game' }));
    await expect(board(page).locator('.cell')).toHaveCount(61);
    await expect(pieces(page, 1)).toHaveCount(3);

    await context.setOffline(false);
  });

  test('the opponent still answers with no network', async ({ page, context }) => {
    await page.goto('/?mode=vs-computer&difficulty=easy&motion=reduced&sound=off');
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: 20_000,
    });
    await press(page.getByRole('button', { name: 'Play Game' }));
    await expect(board(page).locator('.cell')).toHaveCount(61);
    await page.waitForTimeout(500);

    await context.setOffline(true);
    await page.reload();
    await press(page.getByRole('button', { name: 'Play Game' }));

    await press(pieces(page, 1).first());
    await press(board(page).locator('.cell[data-target="clone"]').first());

    // The AI worker has to come from the cache for this to happen at all.
    await expect
      .poll(async () => page.locator('#turnpill').getAttribute('data-player'), { timeout: 20_000 })
      .toBe('1');

    await context.setOffline(false);
  });
});
