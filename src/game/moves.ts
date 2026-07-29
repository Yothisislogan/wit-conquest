/**
 * Move generation and validation.
 *
 * A move is legal when, and only when:
 *   - the game is in play and it is that player's turn (checked in `rules.ts`),
 *   - `from` holds a piece owned by the moving player,
 *   - `to` is a playable space that is currently empty,
 *   - `to` is exactly 1 step (clone) or exactly 2 steps (jump) from `from`.
 *
 * Jumps ignore whatever sits between the two spaces — obstacles block cloning
 * and occupation, never the flight path.
 */

import type { BoardGeometry } from './board.ts';
import { cellStateFor, opponentOf, type CellState, type MoveOption, type MoveType, type PlayerId } from './types.ts';

/** Destinations reachable from `from`, split by move type. */
export interface MoveTargets {
  clone: number[];
  jump: number[];
}

/** True when `index` holds a piece belonging to `player`. */
export function ownsCell(board: readonly CellState[], index: number, player: PlayerId): boolean {
  return board[index] === cellStateFor(player);
}

/**
 * Destinations available from a single piece. Returns empty lists when `from`
 * is not one of `player`'s pieces, so callers can pass raw tap targets.
 */
export function getMoveTargets(
  geo: BoardGeometry,
  board: readonly CellState[],
  from: number,
  player: PlayerId,
): MoveTargets {
  if (from < 0 || from >= board.length || !ownsCell(board, from, player)) {
    return { clone: [], jump: [] };
  }
  return {
    clone: geo.neighbors[from]!.filter((i) => board[i] === 'empty'),
    jump: geo.jumpTargets[from]!.filter((i) => board[i] === 'empty'),
  };
}

/**
 * Classifies a `from`/`to` pair, or returns `null` when the pair is not a legal
 * move for `player` on this board state.
 */
export function classifyMove(
  geo: BoardGeometry,
  board: readonly CellState[],
  from: number,
  to: number,
  player: PlayerId,
): MoveType | null {
  if (from < 0 || from >= board.length || to < 0 || to >= board.length) return null;
  if (!ownsCell(board, from, player)) return null;
  if (board[to] !== 'empty') return null;
  if (geo.neighbors[from]!.includes(to)) return 'clone';
  if (geo.jumpTargets[from]!.includes(to)) return 'jump';
  return null;
}

/** Every legal move for `player`, clone moves first (cheap move ordering). */
export function getLegalMoves(
  geo: BoardGeometry,
  board: readonly CellState[],
  player: PlayerId,
): MoveOption[] {
  const own = cellStateFor(player);
  const clones: MoveOption[] = [];
  const jumps: MoveOption[] = [];
  // A clone's destination does not depend on which adjacent piece produced it,
  // so duplicate clone destinations are collapsed to one canonical move.
  const seenCloneTargets = new Set<number>();

  for (let from = 0; from < board.length; from++) {
    if (board[from] !== own) continue;

    for (const to of geo.neighbors[from]!) {
      if (board[to] !== 'empty' || seenCloneTargets.has(to)) continue;
      seenCloneTargets.add(to);
      clones.push({ from, to, type: 'clone' });
    }
    for (const to of geo.jumpTargets[from]!) {
      if (board[to] !== 'empty') continue;
      jumps.push({ from, to, type: 'jump' });
    }
  }

  return [...clones, ...jumps];
}

/** Fast existence check that stops at the first legal move. */
export function hasLegalMove(
  geo: BoardGeometry,
  board: readonly CellState[],
  player: PlayerId,
): boolean {
  const own = cellStateFor(player);
  for (let from = 0; from < board.length; from++) {
    if (board[from] !== own) continue;
    for (const to of geo.neighbors[from]!) {
      if (board[to] === 'empty') return true;
    }
    for (const to of geo.jumpTargets[from]!) {
      if (board[to] === 'empty') return true;
    }
  }
  return false;
}

/**
 * Opponent pieces that a landing on `to` would flip. Computed from the board as
 * it is *before* the move, which is equivalent because the moving piece only
 * ever lands on an empty space.
 */
export function getConversions(
  geo: BoardGeometry,
  board: readonly CellState[],
  to: number,
  player: PlayerId,
): number[] {
  const enemy = cellStateFor(opponentOf(player));
  const converted: number[] = [];
  for (const index of geo.neighbors[to]!) {
    if (board[index] === enemy) converted.push(index);
  }
  return converted;
}

/** Number of opponent pieces a landing on `to` would flip. */
export function countConversions(
  geo: BoardGeometry,
  board: readonly CellState[],
  to: number,
  player: PlayerId,
): number {
  const enemy = cellStateFor(opponentOf(player));
  let count = 0;
  for (const index of geo.neighbors[to]!) {
    if (board[index] === enemy) count++;
  }
  return count;
}

/**
 * Applies a move to a board array **in place** and returns the flipped indices.
 * Used by the search, which owns its scratch arrays. Gameplay goes through
 * `rules.applyMove`, which is immutable and validates first.
 */
export function applyMoveToBoard(
  geo: BoardGeometry,
  board: CellState[],
  move: MoveOption,
  player: PlayerId,
): number[] {
  const own = cellStateFor(player);
  if (move.type === 'jump') board[move.from] = 'empty';
  board[move.to] = own;

  const converted = getConversions(geo, board, move.to, player);
  for (const index of converted) board[index] = own;
  return converted;
}

/** Reverses {@link applyMoveToBoard} using the flipped indices it returned. */
export function undoMoveOnBoard(
  board: CellState[],
  move: MoveOption,
  player: PlayerId,
  converted: readonly number[],
): void {
  const enemy = cellStateFor(opponentOf(player));
  for (const index of converted) board[index] = enemy;
  board[move.to] = 'empty';
  if (move.type === 'jump') board[move.from] = cellStateFor(player);
}
