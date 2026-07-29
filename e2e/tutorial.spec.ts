import { expect, test } from '@playwright/test';
import { press, watchConsole } from './helpers.ts';

const tutorialBoard = '#tutorial-host .board';

test.describe('tutorial', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?motion=reduced&sound=off');
    await press(page.locator('#btn-tutorial'));
    await expect(page.locator('#screen-tutorial')).toBeVisible();
  });

  test('opens on a small training board with the first lesson', async ({ page }) => {
    await expect(page.locator(tutorialBoard).locator('.cell')).toHaveCount(19);
    await expect(page.locator('#tutorial-step')).toContainText('Step 1 of 5');
    await expect(page.locator('#tutorial-hint')).toContainText(/tap your blue monster/i);
  });

  test('teaches selection, cloning and jumping by doing them', async ({ page }) => {
    const errors = watchConsole(page);

    // Step 1: select.
    await press(page.locator(`${tutorialBoard} .cell:has(.piece--p1)`).first());
    await expect(page.locator(`${tutorialBoard} .cell[data-selected="true"]`)).toHaveCount(1);
    await expect(page.locator('#tutorial-step')).toContainText('Step 2 of 5', { timeout: 6_000 });

    // Step 2: clone.
    await press(page.locator(`${tutorialBoard} .cell:has(.piece--p1)`).first());
    await press(page.locator(`${tutorialBoard} .cell[data-target="clone"]`).first());
    await expect(page.locator(`${tutorialBoard} .cell:has(.piece--p1)`)).toHaveCount(2);
    await expect(page.locator('#tutorial-step')).toContainText('Step 3 of 5', { timeout: 6_000 });

    // Step 3: jump.
    await press(page.locator(`${tutorialBoard} .cell:has(.piece--p1)`).first());
    await press(page.locator(`${tutorialBoard} .cell[data-target="jump"]`).first());
    // A jump moves rather than multiplies, so there is still exactly one.
    await expect(page.locator(`${tutorialBoard} .cell:has(.piece--p1)`)).toHaveCount(1);
    await expect(page.locator('#tutorial-step')).toContainText('Step 4 of 5', { timeout: 6_000 });

    expect(errors).toEqual([]);
  });

  test('can be stepped through with Next and finished', async ({ page }) => {
    for (let step = 1; step < 5; step++) {
      await expect(page.locator('#tutorial-step')).toContainText(`Step ${step} of 5`);
      await press(page.locator('#btn-tutorial-next'));
    }
    await expect(page.locator('#tutorial-step')).toContainText('Step 5 of 5');
    await expect(page.locator('#btn-tutorial-next')).toHaveText('Start playing');

    await press(page.locator('#btn-tutorial-next'));
    await expect(page.locator('#screen-menu')).toBeVisible();
    await expect(page.locator('#screen-tutorial')).toBeHidden();
  });

  test('can be skipped at any point', async ({ page }) => {
    await press(page.locator('#btn-tutorial-skip'));
    await expect(page.locator('#screen-menu')).toBeVisible();
    await expect(page.locator('#screen-tutorial')).toBeHidden();
  });

  test('Back on the first step leaves the tutorial', async ({ page }) => {
    await expect(page.locator('#btn-tutorial-back')).toHaveText('Quit');
    await press(page.locator('#btn-tutorial-back'));
    await expect(page.locator('#screen-menu')).toBeVisible();
  });
});
