/**
 * Observational check that both players obey the rules.
 *
 * Deliberately naive: it never asks the engine whether a move was legal, it
 * watches the board with the same eyes a player has. A MutationObserver records
 * every distinct board layout as it is rendered, and afterwards each consecutive
 * pair has to describe a legal clone or jump by the side that gained a monster.
 * A bug anywhere between the search and the screen — a stale board, a mismatched
 * index, a rendering slip — shows up here even when the engine is convinced it
 * did nothing wrong.
 *
 * Recording rather than polling matters: the computer can answer within a frame
 * of the human's move, so any before/after sampling from the test side races it.
 *
 * This is also the only AI coverage that runs against the real Web Worker. The
 * unit suite cannot reach it — jsdom has no Worker, so those tests only ever
 * exercise the synchronous fallback.
 */

import { expect, test, type Page } from '@playwright/test';
import { press } from './helpers.ts';

interface Recording {
  /** One string per rendered layout: '1', '2', '.' or '#' per space. */
  states: string[];
  /** Space centres in board units, indexed by space. */
  points: Array<{ x: number; y: number }>;
}

/** Installs the recorder before any app code runs. */
async function recordBoardStates(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __states: string[] };
    w.__states = [];
    let last = '';

    const layout = (): string | null => {
      const cells = document.querySelectorAll('#board-host .board .cell');
      if (cells.length === 0) return null;
      let key = '';
      for (const cell of cells) {
        key += cell.querySelector('.piece--p1')
          ? '1'
          : cell.querySelector('.piece--p2')
            ? '2'
            : cell.getAttribute('data-blocked') === 'true'
              ? '#'
              : '.';
      }
      return key;
    };

    const capture = (): void => {
      const key = layout();
      if (key !== null && key !== last) {
        last = key;
        w.__states.push(key);
      }
    };

    // `document` rather than `documentElement`: init scripts run before the
    // root element exists, so observing the element would throw and silently
    // record nothing.
    new MutationObserver(capture).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-blocked'],
    });
  });
}

async function readRecording(page: Page): Promise<Recording> {
  return page.evaluate(() => {
    const points: Array<{ x: number; y: number }> = [];
    for (const cell of document.querySelectorAll('#board-host .board .cell')) {
      const [x, y] = (cell.getAttribute('transform') ?? '')
        .match(/-?[\d.]+/g)!
        .map(Number) as [number, number];
      points[Number(cell.getAttribute('data-index'))] = { x, y };
    }
    return { states: (window as unknown as { __states: string[] }).__states, points };
  });
}

/**
 * Steps between two spaces, from their rendered centres.
 *
 * Flat-top hexes of circumradius 1 sit sqrt(3) apart, so one step is ~1.73 and
 * two steps are 3.0 (diagonal) or ~3.46 (straight). Three steps start at ~4.58,
 * a wide enough gap to classify by distance without ambiguity.
 */
function steps(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  if (d < 0.01) return 0;
  if (d < 2.2) return 1;
  if (d < 3.8) return 2;
  return 99; // too far for any legal move
}

/** Describes a transition, or returns a reason it is not a legal move. */
function checkTransition(before: string, after: string, points: Recording['points']): string | null {
  const appeared: number[] = [];
  const vacated: number[] = [];
  const converted: number[] = [];
  const impossible: string[] = [];
  let mover: '1' | '2' | null = null;

  for (let i = 0; i < before.length; i++) {
    const was = before[i]!;
    const now = after[i]!;
    if (was === now) continue;

    if (was === '.' && (now === '1' || now === '2')) {
      appeared.push(i);
      mover = now;
    } else if ((was === '1' || was === '2') && now === '.') {
      vacated.push(i);
    } else if (was === '1' && now === '2') converted.push(i);
    else if (was === '2' && now === '1') converted.push(i);
    else impossible.push(`space ${i}: ${was} -> ${now}`);
  }

  if (impossible.length > 0) return `no move can explain: ${impossible.join(', ')}`;
  if (appeared.length !== 1 || mover === null) {
    return `expected exactly one monster to arrive, saw ${appeared.length}`;
  }
  if (vacated.length > 1) return `a turn vacates at most one space, saw ${vacated.length}`;

  const to = appeared[0]!;

  if (vacated.length === 1) {
    const from = vacated[0]!;
    if (before[from] !== mover) return `vacated space ${from} was not the mover's`;
    const distance = steps(points[from]!, points[to]!);
    if (distance !== 2) return `jump ${from} -> ${to} spans ${distance} steps, must be exactly 2`;
  } else {
    const hasNeighbour = before
      .split('')
      .some((state, i) => state === mover && steps(points[i]!, points[to]!) === 1);
    if (!hasNeighbour) return `clone into ${to} had no adjacent friendly monster beforehand`;
  }

  for (const index of converted) {
    if (after[index] !== mover) return `space ${index} flipped to the wrong side`;
    const distance = steps(points[index]!, points[to]!);
    if (distance !== 1) return `converted space ${index} is ${distance} steps from the landing space`;
  }

  return null;
}

/**
 * Islands is in the matrix on purpose: its walls stop clones but not jumps, so
 * the computer legitimately leaps a barrier there. That is the move most likely
 * to be mistaken for cheating, and it is the one this test pins down as legal.
 */
const BOARDS = ['classic', 'crossroads', 'islands'] as const;
const DIFFICULTIES = ['easy', 'normal', 'hard'] as const;

test.describe('the computer obeys the rules', () => {
  for (const difficulty of DIFFICULTIES) {
    for (const board of BOARDS) {
    test(`every ${difficulty} move on ${board} is a legal clone or jump`, async ({ page }) => {
      test.slow();
      await recordBoardStates(page);
      await page.goto(
        `/?start=1&mode=vs-computer&board=${board}&difficulty=${difficulty}&motion=reduced&sound=off&seed=7`,
      );
      await expect(page.locator('#board-host .board .cell')).toHaveCount(61);

      for (let turn = 0; turn < 80; turn++) {
        if (await page.locator('#overlay-result').isVisible()) break;
        if (await page.locator('#result-peek').isVisible()) break;

        // Wait for the human's turn, then take any legal move.
        const ours = await expect
          .poll(
            async () => {
              if (await page.locator('#result-peek').isVisible()) return 'over';
              if (await page.locator('#overlay-result').isVisible()) return 'over';
              return page.locator('#turnpill').getAttribute('data-player');
            },
            { timeout: 30_000 },
          )
          .toMatch(/^(1|over)$/)
          .then(() => page.locator('#turnpill').getAttribute('data-player'))
          .catch(() => null);
        if (ours !== '1') break;

        const own = page.locator('#board-host .board .cell:has(.piece--p1)');
        const count = await own.count();
        let played = false;
        for (let i = 0; i < count && !played; i++) {
          await press(own.nth(i));
          const targets = page.locator('#board-host .board .cell[data-target]');
          if ((await targets.count()) > 0) {
            await press(targets.first());
            played = true;
          } else {
            await press(own.nth(i));
          }
        }
        if (!played) break;

        // Give the computer room to answer before looking for our next turn.
        await page.waitForTimeout(120);
      }

      const { states, points } = await readRecording(page);
      expect(states.length, 'the match produced a sequence of board states').toBeGreaterThan(8);

      const failures: string[] = [];
      for (let i = 1; i < states.length; i++) {
        const reason = checkTransition(states[i - 1]!, states[i]!, points);
        if (reason) failures.push(`transition ${i}: ${reason}`);
      }

      expect(failures, `illegal board transitions in ${states.length - 1} moves`).toEqual([]);
    });
    }
  }
});
