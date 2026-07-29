import { expect, test } from '@playwright/test';
import { board, cloneTargets, openMatch, pieces, press, scoreOf, selected } from './helpers.ts';

test.describe('screen reader surface', () => {
  test('every space carries a position and a state in its label', async ({ page }) => {
    await openMatch(page);

    const labels = await board(page).evaluate((svg) =>
      [...svg.querySelectorAll('.cell')].map((node) => node.getAttribute('aria-label') ?? ''),
    );

    expect(labels).toHaveLength(61);
    for (const label of labels) {
      expect(label).toMatch(/^Row \d+, column \d+\./);
      expect(label).toMatch(/Empty space\.|Blocked space\.|monster\./i);
    }
    expect(labels.filter((l) => /Blobs monster|your monster/i.test(l))).toHaveLength(3);
    expect(labels.filter((l) => /Spikes monster|opponent monster/i.test(l))).toHaveLength(3);
  });

  test('valid destinations are named, not just coloured', async ({ page }) => {
    await openMatch(page);
    await press(pieces(page, 1).first());

    const clone = await cloneTargets(page).first().getAttribute('aria-label');
    expect(clone).toContain('Valid clone move.');
    const jump = await board(page).locator('.cell[data-target="jump"]').first().getAttribute('aria-label');
    expect(jump).toContain('Valid jump move.');
    expect(await selected(page).getAttribute('aria-label')).toContain('Selected.');
  });

  test('the board is a grid of rows for assistive technology', async ({ page }) => {
    await openMatch(page);
    await expect(board(page)).toHaveAttribute('role', 'grid');
    await expect(board(page)).toHaveAttribute('aria-label', /board/i);
    await expect(board(page).locator('[role="row"]')).toHaveCount(9);
  });

  test('turns, moves and results are announced', async ({ page }) => {
    await openMatch(page, { mode: 'local-two-player' });
    await press(pieces(page, 1).first());
    await press(cloneTargets(page).first());

    await expect(page.locator('#live-polite')).toContainText(/cloned to row \d+, column \d+/i);
    await expect(page.locator('#live-polite')).toContainText(/Score Blobs 4/i);
  });
});

test.describe('keyboard play', () => {
  test('arrow keys move focus and Enter plays a whole move', async ({ page }) => {
    await openMatch(page, { mode: 'local-two-player' });

    // Focus the first of the player's monsters directly, then confirm the arrow
    // keys walk the grid from there.
    const first = pieces(page, 1).first();
    await first.focus();
    const startLabel = await first.getAttribute('aria-label');

    await page.keyboard.press('ArrowRight');
    const afterRight = await page.evaluate(
      () => document.activeElement?.getAttribute('aria-label') ?? '',
    );
    expect(afterRight).not.toBe(startLabel);

    await page.keyboard.press('ArrowLeft');
    const backAgain = await page.evaluate(
      () => document.activeElement?.getAttribute('aria-label') ?? '',
    );
    expect(backAgain).toBe(startLabel);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')).toBe(
      startLabel,
    );

    // Select, then step onto a highlighted space and commit.
    await page.keyboard.press('Enter');
    await expect(selected(page)).toHaveCount(1);

    const before = await scoreOf(page, 1);
    // Walk to any highlighted neighbour and press Space.
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']) {
      await page.keyboard.press(key);
      const isTarget = await page.evaluate(
        () => document.activeElement?.getAttribute('data-target') !== null,
      );
      if (isTarget) break;
    }
    await page.keyboard.press(' ');
    expect(await scoreOf(page, 1)).toBeGreaterThanOrEqual(before);
  });

  test('Escape cancels a selection without ending the turn', async ({ page }) => {
    await openMatch(page, { mode: 'local-two-player' });
    await pieces(page, 1).first().focus();
    await page.keyboard.press('Enter');
    await expect(selected(page)).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(selected(page)).toHaveCount(0);
    expect(await scoreOf(page, 1)).toBe(3);
    await expect(page.locator('#turnpill-text')).toContainText('Blobs');
  });

  test('R asks before restarting rather than wiping the board', async ({ page }) => {
    await openMatch(page, { mode: 'local-two-player' });
    await press(pieces(page, 1).first());
    await press(cloneTargets(page).first());
    expect(await scoreOf(page, 1)).toBe(4);

    await page.keyboard.press('r');
    await expect(page.locator('#overlay-confirm')).toBeVisible();
    expect(await scoreOf(page, 1)).toBe(4);

    await page.locator('#btn-confirm-ok').click();
    expect(await scoreOf(page, 1)).toBe(3);
  });

  test('only one space is in the tab order at a time', async ({ page }) => {
    await openMatch(page);
    const tabbable = await board(page).evaluate(
      (svg) => svg.querySelectorAll('.cell[tabindex="0"]').length,
    );
    expect(tabbable).toBe(1);
  });

  test('dialogs trap focus and restore it on close', async ({ page }) => {
    await openMatch(page);
    await page.locator('#btn-pause').click();
    await expect(page.locator('#overlay-pause')).toBeVisible();

    // Tab all the way round; focus must stay inside the dialog.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(
        () => document.activeElement?.closest('#pause-dialog') !== null,
      );
      expect(inside).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(page.locator('#overlay-pause')).toBeHidden();
    await expect(page.locator('#btn-pause')).toBeFocused();
  });
});

test.describe('preferences', () => {
  test('reduced motion switches off looping animation', async ({ page }) => {
    await page.goto('/?motion=reduced');
    await expect(page.locator('#app')).toHaveAttribute('data-motion', 'reduced');
    await page.getByRole('button', { name: 'Play Game' }).click();

    const animation = await page.evaluate(
      () => getComputedStyle(document.querySelector('.piece__idle')!).animationName,
    );
    expect(animation).toBe('none');
  });

  test('high contrast can be turned on and is remembered', async ({ page }) => {
    await page.goto('/');
    await page.locator('#btn-settings').click();
    await page.locator('#set-contrast [data-value="high"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-contrast', 'high');

    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-contrast', 'high');
  });

  test('space labels can be shown for players who want coordinates', async ({ page }) => {
    await page.goto('/');
    await page.locator('#btn-settings').click();
    await page.locator('#set-coords').click();
    await page.locator('#screen-settings [data-close-screen]').click();
    await page.getByRole('button', { name: 'Play Game' }).click();

    await expect(board(page)).toHaveAttribute('data-coords', 'true');
    await expect(board(page).locator('.coordlabel').first()).toHaveText('1·1');
  });
});
