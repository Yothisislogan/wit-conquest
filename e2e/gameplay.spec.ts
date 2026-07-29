import { expect, test } from '@playwright/test';
import {
  board,
  cell,
  cloneTargets,
  indexOf,
  jumpTargets,
  openMatch,
  pieces,
  scoreOf,
  selected,
  watchConsole,
  press,
} from './helpers.ts';

test.describe('starting a game', () => {
  test('menu leads into a playable match', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/');

    await expect(page.getByRole('heading', { name: /monster\s*territory/i })).toBeVisible();
    await press(page.getByRole('button', { name: 'Play Game' }));

    await expect(page.locator('#screen-game')).toBeVisible();
    await expect(board(page).locator('.cell')).toHaveCount(61);
    await expect(pieces(page, 1)).toHaveCount(3);
    await expect(pieces(page, 2)).toHaveCount(3);
    expect(await scoreOf(page, 1)).toBe(3);
    expect(await scoreOf(page, 2)).toBe(3);
    expect(errors).toEqual([]);
  });

  test('board choice carries into the match', async ({ page }) => {
    await page.goto('/');
    await press(page.locator('.boardcard[data-value="crossroads"]'));
    await expect(page.locator('.boardcard[data-value="crossroads"]')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await press(page.getByRole('button', { name: 'Play Game' }));
    await expect(page.locator('#screen-game')).toBeVisible();
    // Crossroads is the only layout with a blocked hub.
    await expect(board(page).locator('.cell[data-blocked="true"]')).toHaveCount(13);
  });
});

test.describe('selecting a piece', () => {
  test.beforeEach(async ({ page }) => {
    await openMatch(page);
  });

  test('tapping a monster highlights clone and jump destinations differently', async ({ page }) => {
    await press(pieces(page, 1).first());

    await expect(selected(page)).toHaveCount(1);
    expect(await cloneTargets(page).count()).toBeGreaterThan(0);
    expect(await jumpTargets(page).count()).toBeGreaterThan(0);

    // The two kinds of destination are visually distinct, not just coloured.
    const cloneMarker = cloneTargets(page).first().locator('.marker--clone');
    const jumpMarker = jumpTargets(page).first().locator('.marker--jump');
    await expect(cloneMarker).toHaveCSS('opacity', '0.95');
    await expect(jumpMarker).toHaveCSS('opacity', '0.95');
    await expect(cloneTargets(page).first().locator('.marker--jump')).toHaveCSS('opacity', '0');
  });

  test('tapping the selected monster again cancels', async ({ page }) => {
    const piece = pieces(page, 1).first();
    await press(piece);
    await expect(selected(page)).toHaveCount(1);
    await press(piece);
    await expect(selected(page)).toHaveCount(0);
    await expect(cloneTargets(page)).toHaveCount(0);
  });

  test('tapping another of your monsters moves the selection', async ({ page }) => {
    const all = pieces(page, 1);
    const first = await indexOf(all.nth(0));
    const second = await indexOf(all.nth(1));

    await press(cell(page, first));
    await expect(cell(page, first)).toHaveAttribute('data-selected', 'true');
    await press(cell(page, second));
    await expect(cell(page, second)).toHaveAttribute('data-selected', 'true');
    await expect(selected(page)).toHaveCount(1);
  });

  test('a tap on an unreachable space is ignored and costs nothing', async ({ page }) => {
    await press(pieces(page, 1).first());
    const before = await scoreOf(page, 1);

    // An enemy monster is never a legal destination.
    await press(pieces(page, 2).first());

    await expect(selected(page)).toHaveCount(1);
    expect(await scoreOf(page, 1)).toBe(before);
    await expect(page.locator('#turnpill-text')).toContainText(/Blobs|Your turn/i);
  });
});

test.describe('moves', () => {
  test('completing a clone move adds a monster and keeps the original', async ({ page }) => {
    await openMatch(page);
    const piece = pieces(page, 1).first();
    const from = await indexOf(piece);
    await press(piece);

    const target = cloneTargets(page).first();
    const to = await indexOf(target);
    await press(target);

    await expect(cell(page, from).locator('.piece--p1')).toHaveCount(1);
    await expect(cell(page, to).locator('.piece--p1')).toHaveCount(1);
    expect(await scoreOf(page, 1)).toBe(4);
    await expect(cell(page, to)).toHaveAttribute('data-lastmove', 'to');
  });

  test('completing a jump move vacates the source', async ({ page }) => {
    await openMatch(page);
    const piece = pieces(page, 1).first();
    const from = await indexOf(piece);
    await press(piece);

    const target = jumpTargets(page).first();
    const to = await indexOf(target);
    await press(target);

    await expect(cell(page, from).locator('.piece')).toHaveCount(0);
    await expect(cell(page, to).locator('.piece--p1')).toHaveCount(1);
    // A jump moves a monster rather than creating one.
    expect(await scoreOf(page, 1)).toBe(3);
  });

  test('landing beside an enemy converts it', async ({ page }) => {
    // Two players on one device: drive both sides until a conversion happens.
    await openMatch(page, { mode: 'local-two-player', board: 'classic' });

    let converted = false;
    for (let turn = 0; turn < 30 && !converted; turn++) {
      const mover = (await page.locator('#turnpill').getAttribute('data-player')) === '2' ? 2 : 1;
      const enemy = mover === 1 ? 2 : 1;
      const beforeEnemy = await scoreOf(page, enemy);

      // Prefer a destination that touches an enemy monster.
      const owned = pieces(page, mover);
      const count = await owned.count();
      let played = false;

      for (let i = 0; i < count && !played; i++) {
        await press(owned.nth(i));
        const targets = cloneTargets(page);
        const targetCount = await targets.count();
        for (let t = 0; t < targetCount; t++) {
          const index = await indexOf(targets.nth(t));
          const touchesEnemy = await page.evaluate(
            ([idx, enemyTeam]) => {
              const svg = document.querySelector('#board-host .board')!;
              const node = svg.querySelector(`.cell[data-index="${idx}"]`)!;
              const transform = node.getAttribute('transform')!;
              const [x, y] = transform.match(/-?[\d.]+/g)!.map(Number);
              return [...svg.querySelectorAll(`.cell:has(.piece--p${enemyTeam})`)].some((other) => {
                const [ox, oy] = other.getAttribute('transform')!.match(/-?[\d.]+/g)!.map(Number);
                return Math.hypot(ox! - x!, oy! - y!) < 1.8;
              });
            },
            [index, enemy] as const,
          );
          if (touchesEnemy) {
            await press(targets.nth(t));
            played = true;
            break;
          }
        }
        if (!played) await press(owned.nth(i));
      }

      if (!played) {
        // No converting move available: play any legal clone and try again.
        await press(pieces(page, mover).first());
        await press(cloneTargets(page).first());
      }

      const afterEnemy = await scoreOf(page, enemy);
      if (afterEnemy < beforeEnemy) converted = true;
    }

    expect(converted, 'a conversion happened within 30 turns').toBe(true);
  });
});

test.describe('match lifecycle', () => {
  test('restart asks first, then resets the board', async ({ page }) => {
    await openMatch(page);
    await press(pieces(page, 1).first());
    await press(cloneTargets(page).first());
    expect(await scoreOf(page, 1)).toBe(4);

    await press(page.locator('#btn-restart'));
    await expect(page.locator('#overlay-confirm')).toBeVisible();
    await press(page.locator('#btn-confirm-cancel'));
    expect(await scoreOf(page, 1)).toBe(4);

    await press(page.locator('#btn-restart'));
    await press(page.locator('#btn-confirm-ok'));
    await expect(page.locator('#overlay-confirm')).toBeHidden();
    expect(await scoreOf(page, 1)).toBe(3);
    expect(await scoreOf(page, 2)).toBe(3);
  });

  // A whole match is a rules assertion rather than a layout one, so it runs on
  // a single project instead of four.
  test('a match plays to a finish and reports a result', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-portrait', 'covered once, on the reference layout');
    test.slow();
    const errors = watchConsole(page);
    await openMatch(page, { mode: 'local-two-player', board: 'crossroads' });

    for (let turn = 0; turn < 200; turn++) {
      if (await page.locator('#result-peek').isVisible()) break;
      if (await page.locator('#overlay-result').isVisible()) break;

      const mover = (await page.locator('#turnpill').getAttribute('data-player')) === '2' ? 2 : 1;
      const owned = pieces(page, mover);
      const count = await owned.count();
      let played = false;

      for (let i = 0; i < count && !played; i++) {
        await press(owned.nth(i));
        if ((await cloneTargets(page).count()) > 0) {
          await press(cloneTargets(page).first());
          played = true;
        } else if ((await jumpTargets(page).count()) > 0) {
          await press(jumpTargets(page).first());
          played = true;
        } else {
          await press(owned.nth(i));
        }
      }
      if (!played) break;
    }

    // The final board is shown first; the result sheet is offered, not forced.
    await expect(page.locator('#overlay-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#result-title')).toContainText(/win|tie/i);

    const p1 = await scoreOf(page, 1);
    const p2 = await scoreOf(page, 2);
    const onBoard = await board(page).locator('.piece').count();
    expect(p1 + p2, 'scores always match the monsters on the board').toBe(onBoard);
    await expect(page.locator('#result-stats')).toContainText('Turns');

    // Play again returns to a fresh board rather than the finished one.
    await press(page.locator('#btn-result-again'));
    await expect(page.locator('#overlay-result')).toBeHidden();
    expect(await scoreOf(page, 1)).toBe(3);
    expect(await scoreOf(page, 2)).toBe(3);

    expect(errors).toEqual([]);
  });

  test('the pause menu suspends and resumes without touching the board', async ({ page }) => {
    await openMatch(page, { mode: 'local-two-player', board: 'classic' });
    await press(pieces(page, 1).first());
    await press(cloneTargets(page).first());

    await press(page.locator('#btn-pause'));
    await expect(page.locator('#overlay-pause')).toBeVisible();
    // The modal sits above the board, so a stray tap cannot reach a monster:
    // whatever is under a monster's centre must belong to the dialog.
    const piece = pieces(page, 2).first();
    const box = (await piece.boundingBox())!;
    const hitsDialog = await page.evaluate(
      ([x, y]) => {
        const node = document.elementFromPoint(x!, y!);
        return node !== null && node.closest('#overlay-pause') !== null;
      },
      [box.x + box.width / 2, box.y + box.height / 2] as const,
    );
    expect(hitsDialog).toBe(true);
    await expect(selected(page)).toHaveCount(0);

    await press(page.locator('#btn-pause-resume'));
    await expect(page.locator('#overlay-pause')).toBeHidden();
    expect(await scoreOf(page, 1)).toBe(4);
  });
});

test.describe('modes and difficulty', () => {
  test('the computer answers with its own move', async ({ page }) => {
    await openMatch(page, { mode: 'vs-computer', difficulty: 'easy' });

    await press(pieces(page, 1).first());
    await press(cloneTargets(page).first());

    // Player 2 is the computer: it must gain ground on its own.
    await expect
      .poll(async () => scoreOf(page, 2), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3);
    await expect.poll(async () => page.locator('#turnpill').getAttribute('data-player')).toBe('1');
    expect(await scoreOf(page, 1)).toBe(4);
  });

  test('difficulty can be changed from the menu', async ({ page }) => {
    await page.goto('/');
    await press(page.getByRole('radio', { name: 'Hard' }));
    await expect(page.getByRole('radio', { name: 'Hard' })).toHaveAttribute('aria-checked', 'true');
    await press(page.getByRole('button', { name: 'Play Game' }));
    await expect(page.locator('#screen-game')).toBeVisible();
    await expect(page.locator('#panel-mode')).toContainText('hard');
  });

  test('local two player hands the device between teams', async ({ page }) => {
    await page.goto('/');
    await press(page.getByRole('radio', { name: '2 Players' }));
    // The difficulty picker is irrelevant with no computer in the match.
    await expect(page.locator('#option-difficulty')).toBeHidden();
    await press(page.getByRole('button', { name: 'Play Game' }));

    await expect(page.locator('#turnpill-text')).toContainText('Blobs');
    await press(pieces(page, 1).first());
    await press(cloneTargets(page).first());
    await expect(page.locator('#turnpill-text')).toContainText('Spikes');

    // The second player really does control their own monsters.
    await press(pieces(page, 2).first());
    await expect(selected(page)).toHaveCount(1);
  });
});
