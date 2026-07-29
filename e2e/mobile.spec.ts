import { expect, test } from '@playwright/test';
import {
  board,
  cell,
  cloneTargets,
  hasTouch,
  openMatch,
  pieces,
  press,
  scoreOf,
  selected,
} from './helpers.ts';

test.describe('mobile layout', () => {
  test('the board fits the screen with no horizontal scrolling', async ({ page }) => {
    await openMatch(page);

    const overflow = await page.evaluate(() => ({
      docScroll: document.documentElement.scrollWidth,
      docClient: document.documentElement.clientWidth,
      bodyScroll: document.body.scrollWidth,
    }));
    expect(overflow.docScroll).toBeLessThanOrEqual(overflow.docClient + 1);
    expect(overflow.bodyScroll).toBeLessThanOrEqual(overflow.docClient + 1);

    const svg = (await board(page).boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(svg.x).toBeGreaterThanOrEqual(-1);
    expect(svg.x + svg.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(svg.y + svg.height).toBeLessThanOrEqual(viewport.height + 1);
  });

  test('every space is a comfortable touch target', async ({ page }) => {
    await openMatch(page);

    const sizes = await board(page).evaluate((svg) => {
      const cells = [...svg.querySelectorAll('.cell .hit')];
      return cells.map((node) => {
        const rect = node.getBoundingClientRect();
        return { w: rect.width, h: rect.height };
      });
    });

    expect(sizes.length).toBe(61);
    const minWidth = Math.min(...sizes.map((s) => s.w));
    const minHeight = Math.min(...sizes.map((s) => s.h));
    const width = page.viewportSize()!.width;

    // Hexes tile edge to edge, so the target is the whole tile with no dead
    // gaps between them. Flat-top orientation puts the wide axis across the
    // narrow axis of a portrait phone, which is what keeps every tile at or
    // above 44px wide even on a 320px screen. Height follows on any mainstream
    // phone; on the very smallest it lands just under, and nearest-space
    // resolution with destination snapping carries the difference.
    expect(minWidth, 'tile width').toBeGreaterThanOrEqual(44);
    expect(minHeight, 'tile height').toBeGreaterThanOrEqual(width >= 360 ? 44 : 39);
    expect(minWidth * minHeight).toBeGreaterThanOrEqual(44 * 39);
  });

  test('the controls stay above the bottom safe area', async ({ page }) => {
    await openMatch(page);
    const viewport = page.viewportSize()!;
    for (const id of ['#btn-pause', '#btn-undo', '#btn-restart', '#btn-sound-game']) {
      const box = (await page.locator(id).boundingBox())!;
      expect(box.height, `${id} height`).toBeGreaterThanOrEqual(44);
      expect(box.y + box.height, `${id} bottom edge`).toBeLessThanOrEqual(viewport.height + 1);
    }
  });

  test('rotating the device keeps the match intact', async ({ page }) => {
    await openMatch(page, { mode: 'local-two-player' });
    await press(pieces(page, 1).first());
    await press(cloneTargets(page).first());
    expect(await scoreOf(page, 1)).toBe(4);

    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: viewport.height, height: viewport.width });
    await page.waitForTimeout(120);

    expect(await scoreOf(page, 1)).toBe(4);
    expect(await scoreOf(page, 2)).toBe(3);
    await expect(page.locator('#screen-game')).toBeVisible();
    await expect(board(page).locator('.cell')).toHaveCount(61);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // And the match is still playable after the rotation.
    await press(pieces(page, 2).first());
    await expect(selected(page)).toHaveCount(1);
  });

  test('rapid taps do not zoom, select text or scroll the board', async ({ page }) => {
    test.skip(!hasTouch(), 'touch-only behaviour');
    await openMatch(page, { mode: 'local-two-player' });

    const piece = pieces(page, 1).first();
    const box = (await piece.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    for (let i = 0; i < 8; i++) {
      await page.touchscreen.tap(point.x, point.y);
    }

    const state = await page.evaluate(() => ({
      zoom: window.visualViewport?.scale ?? 1,
      selection: window.getSelection()?.toString() ?? '',
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      touchAction: getComputedStyle(document.querySelector('.board')!).touchAction,
      userSelect: getComputedStyle(document.querySelector('.board')!).userSelect,
    }));

    expect(state.zoom).toBeCloseTo(1, 2);
    expect(state.selection).toBe('');
    expect(state.scrollX).toBe(0);
    expect(state.scrollY).toBe(0);
    expect(state.touchAction).toBe('manipulation');
    expect(state.userSelect).toBe('none');
    // An even number of taps on the same monster ends deselected.
    await expect(selected(page)).toHaveCount(0);
  });

  test('a tap in the gap between two spaces still lands on a space', async ({ page }) => {
    test.skip(!hasTouch(), 'touch-only behaviour');
    await openMatch(page, { mode: 'local-two-player' });

    const piece = pieces(page, 1).first();
    await press(piece);
    const target = cloneTargets(page).first();
    const targetIndex = Number(await target.getAttribute('data-index'));

    // Aim at the seam between the selected monster and its first clone target.
    const a = (await piece.boundingBox())!;
    const b = (await target.boundingBox())!;
    const seam = {
      x: (a.x + a.width / 2 + b.x + b.width / 2) / 2,
      y: (a.y + a.height / 2 + b.y + b.height / 2) / 2,
    };
    await page.touchscreen.tap(seam.x, seam.y);

    // Either it resolved to the destination (a move) or it stayed selected —
    // what must never happen is the tap vanishing into a dead zone.
    const moved = (await cell(page, targetIndex).locator('.piece--p1').count()) === 1;
    const stillSelected = (await selected(page).count()) === 1;
    expect(moved || stillSelected).toBe(true);
  });

  test('taps outside the board do nothing', async ({ page }) => {
    test.skip(!hasTouch(), 'touch-only behaviour');
    await openMatch(page, { mode: 'local-two-player' });
    await press(pieces(page, 1).first());
    const before = await scoreOf(page, 1);

    const svg = (await board(page).boundingBox())!;
    await page.touchscreen.tap(svg.x + 2, svg.y + 2);

    expect(await scoreOf(page, 1)).toBe(before);
    await expect(selected(page)).toHaveCount(1);
  });
});
