/**
 * Legal moves that look illegal.
 *
 * Two things in this game are correct by the rules but read as the opponent
 * cheating unless the interface says otherwise:
 *
 *  - a jump crosses two spaces, over whatever is in between, so a monster can
 *    appear a quarter of the board away from where it started;
 *  - a player with no legal move is skipped, so the other side moves twice (or
 *    more) in a row.
 *
 * These tests hold the interface to explaining both.
 */

import { expect, test, type Page } from '@playwright/test';
import { press } from './helpers.ts';

interface Cell {
  index: number;
  x: number;
  y: number;
  blocked: boolean;
}

async function readCells(page: Page): Promise<Cell[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('#board-host .board .cell')].map((node) => {
      const [x, y] = (node.getAttribute('transform') ?? '')
        .match(/-?[\d.]+/g)!
        .map(Number) as [number, number];
      return {
        index: Number(node.getAttribute('data-index')),
        x,
        y,
        blocked: node.getAttribute('data-blocked') === 'true',
      };
    }),
  );
}

/** Steps apart, from rendered centres. One step is sqrt(3) board units. */
function steps(a: Cell, b: Cell): number {
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  if (d < 0.01) return 0;
  if (d < 2.2) return 1;
  if (d < 3.8) return 2;
  return 99;
}

test.describe('a jump is legible as a move', () => {
  test('leaves a trail from the space it left', async ({ page }) => {
    await page.goto('/?start=1&mode=local-two-player&board=islands&motion=reduced&sound=off');
    await expect(page.locator('#board-host .board .cell')).toHaveCount(61);

    const cells = await readCells(page);
    const source = page.locator('#board-host .board .cell:has(.piece--p1)').first();
    const from = Number(await source.getAttribute('data-index'));

    await press(source);
    const target = page.locator('#board-host .board .cell[data-target="jump"]').first();
    const to = Number(await target.getAttribute('data-index'));
    await press(target);

    // One trail, drawn from the vacated space to the landing space.
    const trail = page.locator('.trail');
    await expect(trail).toHaveCount(1);
    await expect(trail).toHaveClass(/trail--p1/);

    const path = (await trail.getAttribute('d'))!;
    const numbers = path.match(/-?[\d.]+/g)!.map(Number);
    const start = { x: numbers[0]!, y: numbers[1]! };
    const end = { x: numbers[4]!, y: numbers[5]! };

    const fromCell = cells.find((c) => c.index === from)!;
    const toCell = cells.find((c) => c.index === to)!;
    expect(Math.hypot(start.x - fromCell.x, start.y - fromCell.y)).toBeLessThan(0.01);
    expect(Math.hypot(end.x - toCell.x, end.y - toCell.y)).toBeLessThan(0.01);
  });

  test('a clone draws no trail, because the original is still there', async ({ page }) => {
    await page.goto('/?start=1&mode=local-two-player&board=classic&motion=reduced&sound=off');
    await press(page.locator('#board-host .board .cell:has(.piece--p1)').first());
    await press(page.locator('#board-host .board .cell[data-target="clone"]').first());
    await expect(page.locator('.trail')).toHaveCount(0);
  });
});

test.describe('a skipped turn is explained', () => {
  /**
   * Two players on one device, so every move in the scenario is chosen by the
   * test rather than by a search.
   *
   * Player 1 is walled in: its single monster has every space within two steps
   * occupied by player 2. Player 2 then plays twice — a clone, which leaves
   * player 1 stuck and triggers the skip, and then a jump that vacates a space
   * inside the wall and hands player 1 its turn back.
   *
   * That second move is the whole point. It is the moment the interface used to
   * replace "you have no legal moves" with routine guidance, a few hundred
   * milliseconds after showing it — long before anyone could read why their
   * opponent had just moved twice.
   */
  test('the explanation survives the opponent immediately moving again', async ({ page }) => {
    await page.goto('/?start=1&mode=local-two-player&board=classic&motion=reduced&sound=off');
    await expect(page.locator('#board-host .board .cell')).toHaveCount(61);
    const cells = await readCells(page);

    const cx = cells.reduce((sum, c) => sum + c.x, 0) / cells.length;
    const cy = cells.reduce((sum, c) => sum + c.y, 0) / cells.length;
    const trapped = cells
      .filter((c) => !c.blocked)
      .reduce((far, c) =>
        Math.hypot(c.x - cx, c.y - cy) > Math.hypot(far.x - cx, far.y - cy) ? c : far,
      );

    // Wall of player 2 monsters filling every space within two steps.
    const wall = cells.filter((c) => !c.blocked && c.index !== trapped.index && steps(c, trapped) <= 2);
    const board = cells
      .map((cell) => {
        if (cell.blocked) return '#';
        if (cell.index === trapped.index) return '1';
        return wall.some((w) => w.index === cell.index) ? '2' : '.';
      })
      .join('');

    await page.evaluate(
      ([payload]) => localStorage.setItem('monster-territory:save', payload!),
      [
        JSON.stringify({
          v: 1,
          boardId: 'classic',
          board,
          currentPlayer: 2,
          turnNumber: 9,
          status: 'playing',
          winner: null,
          lastMove: null,
          skippedPlayers: [],
        }),
      ],
    );
    await page.goto(
      '/?start=1&resume=1&mode=local-two-player&board=classic&motion=reduced&sound=off',
    );
    await expect(page.locator('#board-host .board .cell:has(.piece--p1)')).toHaveCount(1);

    const cell = (index: number) => page.locator(`#board-host .board .cell[data-index="${index}"]`);

    // Move 1: a clone from the outer edge of the wall. Nothing is vacated, so
    // player 1 stays stuck and is skipped.
    const outer = wall.filter((w) => steps(w, trapped) === 2);
    let cloned = false;
    for (const candidate of outer) {
      await press(cell(candidate.index));
      const clone = page.locator('#board-host .board .cell[data-target="clone"]');
      if ((await clone.count()) > 0) {
        await press(clone.first());
        cloned = true;
        break;
      }
      await press(cell(candidate.index));
    }
    expect(cloned, 'player 2 had a clone available').toBe(true);
    await expect(page.locator('#hintbar')).toContainText(/no legal moves/i);

    // Move 2: jump a wall monster away, which frees player 1 and immediately
    // makes the routine "your turn" guidance applicable again.
    let jumped = false;
    for (const candidate of outer) {
      await press(cell(candidate.index));
      const jump = page.locator('#board-host .board .cell[data-target="jump"]');
      if ((await jump.count()) > 0) {
        await press(jump.first());
        jumped = true;
        break;
      }
      await press(cell(candidate.index));
    }
    expect(jumped, 'player 2 had a jump available').toBe(true);

    // The explanation has to still be readable right after that second move.
    await expect(page.locator('#hintbar')).toContainText(/no legal moves/i);
    await page.waitForTimeout(700);
    await expect(page.locator('#hintbar')).toContainText(/no legal moves/i);
    await expect(page.locator('#live-assertive')).toContainText(/no legal moves/i);
  });

  test('the held message gives way once it has been read', async ({ page }) => {
    await page.goto('/?start=1&mode=local-two-player&board=classic&motion=reduced&sound=off');
    await press(page.locator('#board-host .board .cell:has(.piece--p1)').first());
    await press(page.locator('#board-host .board .cell[data-target="clone"]').first());
    await expect(page.locator('#hintbar')).toContainText(/tap one of your monsters|tap a dot/i);
  });
});
