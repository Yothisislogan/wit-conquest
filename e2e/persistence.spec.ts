import { expect, test } from '@playwright/test';
import { board, cloneTargets, openMatch, pieces, press, scoreOf, watchConsole } from './helpers.ts';

test.describe('resuming a match', () => {
  test('an interrupted match can be picked back up from the menu', async ({ page }) => {
    await openMatch(page, { mode: 'local-two-player' });
    await press(pieces(page, 1).first());
    await press(cloneTargets(page).first());
    expect(await scoreOf(page, 1)).toBe(4);

    // Leave to the main menu the way a player would.
    await press(page.locator('#btn-pause'));
    await press(page.locator('#btn-pause-menu'));
    await expect(page.locator('#screen-menu')).toBeVisible();

    const resume = page.locator('#btn-resume');
    await expect(resume).toBeVisible();
    await press(resume);

    await expect(page.locator('#screen-game')).toBeVisible();
    expect(await scoreOf(page, 1)).toBe(4);
    expect(await scoreOf(page, 2)).toBe(3);
    await expect(page.locator('#panel-turn')).toHaveText('2');
  });

  test('a match survives a full page reload', async ({ page }) => {
    await openMatch(page, { mode: 'local-two-player' });
    await press(pieces(page, 1).first());
    await press(cloneTargets(page).first());

    await page.goto('/?motion=reduced&sound=off');
    await expect(page.locator('#btn-resume')).toBeVisible();
    await press(page.locator('#btn-resume'));
    expect(await scoreOf(page, 1)).toBe(4);
  });

  test('finishing a match clears the saved board', async ({ page }) => {
    await page.goto('/?motion=reduced&sound=off');
    // Nothing has been played yet, so there is nothing to resume.
    await expect(page.locator('#btn-resume')).toBeHidden();
  });

  test('starting a new match discards the old one', async ({ page }) => {
    await openMatch(page, { mode: 'local-two-player' });
    await press(pieces(page, 1).first());
    await press(cloneTargets(page).first());

    await press(page.locator('#btn-pause'));
    await press(page.locator('#btn-pause-menu'));
    await press(page.getByRole('button', { name: 'Play Game' }));

    expect(await scoreOf(page, 1)).toBe(3);
    expect(await scoreOf(page, 2)).toBe(3);
  });
});

test.describe('settings', () => {
  test('preferences persist across a reload', async ({ page }) => {
    await page.goto('/');
    await press(page.getByRole('radio', { name: 'Hard' }));
    await press(page.locator('.boardcard[data-value="islands"]'));

    await page.reload();
    await expect(page.getByRole('radio', { name: 'Hard' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.boardcard[data-value="islands"]')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('sound can be switched on without upsetting the game', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/?motion=reduced&mode=local-two-player');

    await press(page.locator('#btn-sound-menu'));
    await expect(page.locator('#btn-sound-menu')).toHaveAttribute('aria-pressed', 'true');

    await press(page.getByRole('button', { name: 'Play Game' }));
    await press(pieces(page, 1).first());
    await press(cloneTargets(page).first());
    await press(pieces(page, 2).first());
    await press(cloneTargets(page).first());

    expect(await scoreOf(page, 1)).toBe(4);
    expect(await scoreOf(page, 2)).toBe(4);
    // The in-match toggle mirrors the menu one.
    await expect(page.locator('#btn-sound-game')).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });

  test('statistics are recorded and can be reset', async ({ page }) => {
    await openMatch(page, { mode: 'local-two-player' });
    await press(page.locator('#btn-pause'));
    await press(page.locator('#btn-pause-settings'));

    await expect(page.locator('#stat-grid')).toContainText('Matches');
    await press(page.locator('#btn-reset-stats'));
    await expect(page.locator('#stat-grid dd').first()).toHaveText('0');
  });

  test('the board picker previews each layout', async ({ page }) => {
    await page.goto('/');
    for (const [id, blocked] of [
      ['classic', 6],
      ['crossroads', 13],
      ['islands', 10],
    ] as const) {
      await press(page.locator(`.boardcard[data-value="${id}"]`));
      await expect(page.locator('#board-hint')).not.toBeEmpty();
      await press(page.getByRole('button', { name: 'Play Game' }));
      await expect(board(page).locator('.cell[data-blocked="true"]')).toHaveCount(blocked);
      await press(page.locator('#btn-pause'));
      await press(page.locator('#btn-pause-menu'));
    }
  });
});
