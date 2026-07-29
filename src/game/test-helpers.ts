/** Shared fixtures for the rules tests. Not shipped in the app bundle. */

import { compileBoard, type BoardDefinition, type BoardGeometry } from './board.ts';
import { hexId } from './hex.ts';
import { getLegalMoves } from './moves.ts';
import { computeScores } from './scoring.ts';
import { createInitialState } from './rules.ts';
import type { Axial, CellState, GameState, PlayerId } from './types.ts';

/** A bare radius-2 hexagon (19 spaces) — small enough to reason about by hand. */
export const SMALL_BOARD: BoardDefinition = {
  id: 'test-small',
  name: 'Test small',
  description: 'test',
  strategy: 'test',
  radius: 2,
  blocked: [],
  starts: [],
};

export function smallBoard(): BoardGeometry {
  return compileBoard(SMALL_BOARD);
}

export function indexAt(geo: BoardGeometry, q: number, r: number): number {
  const index = geo.indexById.get(hexId(q, r));
  if (index === undefined) throw new Error(`No cell at ${q},${r} on ${geo.id}`);
  return index;
}

/** Builds a board array with only the listed pieces placed. */
export function position(
  geo: BoardGeometry,
  pieces: { player1?: Axial[]; player2?: Axial[] },
): CellState[] {
  const board = geo.initialBoard.map((state) => (state === 'blocked' ? 'blocked' : 'empty')) as CellState[];
  for (const coord of pieces.player1 ?? []) board[indexAt(geo, coord.q, coord.r)] = 'player1';
  for (const coord of pieces.player2 ?? []) board[indexAt(geo, coord.q, coord.r)] = 'player2';
  return board;
}

/** A playable state built around a hand-authored position. */
export function stateFrom(
  geo: BoardGeometry,
  pieces: { player1?: Axial[]; player2?: Axial[] },
  currentPlayer: PlayerId = 1,
): GameState {
  const board = position(geo, pieces);
  return {
    ...createInitialState(geo),
    board,
    currentPlayer,
    scores: computeScores(board),
  };
}

/** Deterministic RNG so playout tests reproduce exactly. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks a uniformly random legal move, or `null` when there is none. */
export function randomMove(geo: BoardGeometry, board: readonly CellState[], player: PlayerId, rng: () => number) {
  const moves = getLegalMoves(geo, board, player);
  if (moves.length === 0) return null;
  return moves[Math.floor(rng() * moves.length)]!;
}
