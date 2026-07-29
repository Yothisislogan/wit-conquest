/**
 * The "Normal" monster.
 *
 * A full alpha-beta search, but capped at three plies: it sees its own move,
 * your best answer, and its follow-up. That is exactly deep enough to stop it
 * walking into a big counter-conversion — the mistake that makes an opponent
 * feel broken — without giving it the long-range plans that make "Hard" hard.
 *
 * The evaluation it uses also cares less about its own exposure than the hard
 * weights do, so it still leaves pieces hanging in quiet positions.
 */

import type { BoardGeometry } from '../game/board.ts';
import type { CellState, PlayerId } from '../game/types.ts';
import { WEIGHTS } from './evaluate-board.ts';
import { searchBestMove } from './minimax.ts';
import type { AiOptions, AiResult, MoveChooser } from './types.ts';

/** Own move, reply, follow-up. */
const NORMAL_MAX_DEPTH = 3;

/**
 * Tie-break width, in evaluation units. Well below the value of a single
 * converted piece, so it only ever chooses between moves the search rated
 * equally — it keeps repeated matches from replaying move for move.
 */
const NORMAL_JITTER = 12;

export const chooseNormalMove: MoveChooser = (
  geo: BoardGeometry,
  board: readonly CellState[],
  player: PlayerId,
  options: AiOptions,
): AiResult | null =>
  searchBestMove(geo, board, player, {
    timeLimitMs: options.timeLimitMs,
    random: options.random,
    now: options.now,
    maxDepth: NORMAL_MAX_DEPTH,
    weights: WEIGHTS.normal,
    jitter: NORMAL_JITTER,
  });
