/**
 * The "Easy" monster.
 *
 * Goal: readable, beatable, and never *insultingly* random. It sees the obvious
 * capture and takes it most of the time, but a third of its turns it plays any
 * legal move at all — which is where a new player's comeback comes from. There
 * is no lookahead, so it never notices that the capture it just made hands back
 * five pieces on the reply.
 */

import type { BoardGeometry } from '../game/board.ts';
import { applyMoveToBoard, countConversions, getLegalMoves } from '../game/moves.ts';
import type { CellState, MoveOption, PlayerId } from '../game/types.ts';
import { WEIGHTS, evaluateBoard } from './evaluate-board.ts';
import type { AiOptions, AiResult, MoveChooser } from './types.ts';

/**
 * Fraction of turns played without looking for captures at all. Tuned by feel:
 * high enough that a beginner wins roughly half their games, low enough that
 * the opponent still looks like it is playing the same game as you.
 */
const BLUNDER_CHANCE = 0.34;

export const chooseEasyMove: MoveChooser = (
  geo: BoardGeometry,
  board: readonly CellState[],
  player: PlayerId,
  options: AiOptions,
): AiResult | null => {
  const now = options.now;
  const started = now ? now() : 0;

  const legal = getLegalMoves(geo, board, player);
  if (legal.length === 0) return null;

  const move = selectMove(geo, board, player, legal, options.random);

  // Report the evaluation of the resulting position so the debug overlay and
  // the worker protocol carry the same shape of data for every difficulty.
  const after = [...board];
  applyMoveToBoard(geo, after, move, player);

  return {
    move,
    depth: 0,
    nodes: legal.length,
    elapsedMs: now ? now() - started : 0,
    evaluation: evaluateBoard(geo, after, player, WEIGHTS.easy),
  };
};

function selectMove(
  geo: BoardGeometry,
  board: readonly CellState[],
  player: PlayerId,
  legal: MoveOption[],
  random: () => number,
): MoveOption {
  // The deliberate mistake: pick blind, captures and all.
  if (random() < BLUNDER_CHANCE) return pick(legal, random);

  const capturing = legal.filter((m) => countConversions(geo, board, m.to, player) > 0);
  if (capturing.length > 0) return pick(capturing, random);

  // Nothing to take. Clones at least keep the piece that made them, which is
  // the one piece of strategy this opponent understands.
  const clones = legal.filter((m) => m.type === 'clone');
  return pick(clones.length > 0 ? clones : legal, random);
}

function pick(moves: MoveOption[], random: () => number): MoveOption {
  // Clamped so a random() that returns exactly 1 can never index off the end.
  return moves[Math.min(moves.length - 1, Math.floor(random() * moves.length))]!;
}
