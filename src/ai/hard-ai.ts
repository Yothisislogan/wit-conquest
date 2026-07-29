/**
 * The "Hard" monster.
 *
 * Iterative-deepening alpha-beta that spends its whole time budget and stops on
 * the millisecond. The depth cap is generous rather than binding: on a 61-space
 * board the branching factor is large enough that the clock, not the cap, ends
 * the search in the middlegame — but late in the game, when only a handful of
 * spaces are left, it will happily search to the end of the match and play the
 * proven win.
 */

import type { BoardGeometry } from '../game/board.ts';
import type { CellState, PlayerId } from '../game/types.ts';
import { WEIGHTS } from './evaluate-board.ts';
import { searchBestMove } from './minimax.ts';
import type { AiOptions, AiResult, MoveChooser } from './types.ts';

/**
 * Upper bound on iterative deepening. Reached only in sparse endgames; the
 * wall clock stops the search long before this in the middlegame.
 */
const HARD_MAX_DEPTH = 10;

/**
 * Barely-there tie-break so the opening does not replay identically every
 * match. Alpha-beta returns the true best score for a completed iteration
 * whatever the move order, so this can only choose between equal moves.
 */
const HARD_JITTER = 2;

export const chooseHardMove: MoveChooser = (
  geo: BoardGeometry,
  board: readonly CellState[],
  player: PlayerId,
  options: AiOptions,
): AiResult | null =>
  searchBestMove(geo, board, player, {
    timeLimitMs: options.timeLimitMs,
    random: options.random,
    now: options.now,
    maxDepth: HARD_MAX_DEPTH,
    weights: WEIGHTS.hard,
    jitter: HARD_JITTER,
  });
