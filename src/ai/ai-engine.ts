/**
 * Difficulty dispatcher. This is the only entry point callers should use; it is
 * shared by the Web Worker and by the synchronous fallback path.
 */

import type { BoardGeometry } from '../game/board.ts';
import { getLegalMoves } from '../game/moves.ts';
import type { CellState, PlayerId } from '../game/types.ts';
import { chooseEasyMove } from './easy-ai.ts';
import { chooseHardMove } from './hard-ai.ts';
import { chooseNormalMove } from './normal-ai.ts';
import type { AiOptions, AiResult, Difficulty } from './types.ts';

const CHOOSERS = {
  easy: chooseEasyMove,
  normal: chooseNormalMove,
  hard: chooseHardMove,
} as const;

/**
 * Picks a move for `player`. Returns `null` only when the player genuinely has
 * no legal move.
 *
 * The result is re-validated against the legal move list before it is returned,
 * so a bug in a search cannot produce an illegal move on the board.
 */
export function chooseMove(
  geo: BoardGeometry,
  board: readonly CellState[],
  player: PlayerId,
  difficulty: Difficulty,
  options: AiOptions,
): AiResult | null {
  const legal = getLegalMoves(geo, board, player);
  if (legal.length === 0) return null;

  let result: AiResult | null = null;
  try {
    result = CHOOSERS[difficulty](geo, board, player, options);
  } catch (error) {
    // A search failure must never strand the match: fall through to a legal
    // move rather than leaving the player waiting on a broken turn.
    if (import.meta.env?.DEV) console.error('AI search failed, falling back', error);
    result = null;
  }

  const isLegal =
    result !== null &&
    legal.some(
      (m) => m.from === result!.move.from && m.to === result!.move.to && m.type === result!.move.type,
    );

  if (isLegal) return result;

  const fallback = legal[Math.min(legal.length - 1, Math.floor(options.random() * legal.length))]!;
  return { move: fallback, depth: 0, nodes: 0, elapsedMs: 0, evaluation: 0 };
}
