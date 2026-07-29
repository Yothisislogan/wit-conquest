import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Deep-links straight into a match. `motion=reduced` removes the cosmetic
 * delays so the suite exercises the game rather than the easing curves.
 */
export async function openMatch(
  page: Page,
  options: {
    mode?: 'vs-computer' | 'local-two-player';
    board?: 'classic' | 'crossroads' | 'islands';
    difficulty?: 'easy' | 'normal' | 'hard';
    seed?: number;
  } = {},
): Promise<void> {
  const query = new URLSearchParams({
    start: '1',
    motion: 'reduced',
    sound: 'off',
    mode: options.mode ?? 'local-two-player',
    board: options.board ?? 'classic',
    difficulty: options.difficulty ?? 'easy',
    seed: String(options.seed ?? 12345),
  });
  await page.goto(`/?${query.toString()}`);
  await expect(page.locator('#screen-game')).toBeVisible();
  await expect(board(page).locator('.cell')).toHaveCount(61);
}

/**
 * Activates a control the way the current project's user would: a real tap on
 * the touch projects, a click on desktop. Touch is the primary control method,
 * so the same specs run both ways rather than being written twice.
 */
export async function press(locator: Locator): Promise<void> {
  if (hasTouch()) await locator.tap();
  else await locator.click();
}

export function hasTouch(): boolean {
  return test.info().project.use.hasTouch === true;
}

export function board(page: Page): Locator {
  return page.locator('#board-host .board');
}

export function cell(page: Page, index: number): Locator {
  return board(page).locator(`.cell[data-index="${index}"]`);
}

/** Every space currently holding a monster of the given team. */
export function pieces(page: Page, player: 1 | 2): Locator {
  return board(page).locator(`.cell:has(.piece--p${player})`);
}

export function cloneTargets(page: Page): Locator {
  return board(page).locator('.cell[data-target="clone"]');
}

export function jumpTargets(page: Page): Locator {
  return board(page).locator('.cell[data-target="jump"]');
}

export function selected(page: Page): Locator {
  return board(page).locator('.cell[data-selected="true"]');
}

export async function scoreOf(page: Page, player: 1 | 2): Promise<number> {
  const text = await page.locator(`#score-p${player} [data-score]`).textContent();
  return Number(text ?? '0');
}

export async function indexOf(locator: Locator): Promise<number> {
  return Number(await locator.getAttribute('data-index'));
}

/** Collects console errors so a test can assert the app stayed quiet. */
export function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}
