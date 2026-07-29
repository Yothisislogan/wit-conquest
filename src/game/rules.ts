/**
 * The rules engine: the single place where a board state is allowed to change.
 *
 * Everything here is pure and immutable — `applyMove` returns a new state and
 * never mutates its input. The UI cannot bypass validation because it has no
 * other way to produce a `GameState`.
 */

import type { BoardGeometry } from './board.ts';
import {
  applyMoveToBoard,
  classifyMove,
  getConversions,
  hasLegalMove,
} from './moves.ts';
import { computeScores, determineWinner } from './scoring.ts';
import {
  cellStateFor,
  opponentOf,
  type CellState,
  type GameState,
  type Move,
  type PlayerId,
} from './types.ts';

export interface MoveResult {
  state: GameState;
  move: Move;
  /** Players skipped while resolving the turn hand-off, in order. */
  skipped: PlayerId[];
  /** True when this move ended the match. */
  gameOver: boolean;
}

export type MoveRejection =
  | 'not-playing'
  | 'not-your-piece'
  | 'destination-not-empty'
  | 'out-of-range'
  | 'out-of-bounds';

export class IllegalMoveError extends Error {
  readonly reason: MoveRejection;
  constructor(reason: MoveRejection, message: string) {
    super(message);
    this.name = 'IllegalMoveError';
    this.reason = reason;
  }
}

/** A fresh state for the given layout, with player 1 to move. */
export function createInitialState(geo: BoardGeometry): GameState {
  const board = [...geo.initialBoard];
  return {
    boardId: geo.id,
    board,
    currentPlayer: 1,
    selectedCell: null,
    scores: computeScores(board),
    status: 'playing',
    winner: null,
    turnNumber: 1,
    lastMove: null,
    skippedPlayers: [],
  };
}

/**
 * Explains why a move would be rejected, or returns `null` when it is legal.
 * Kept separate from `applyMove` so the UI can give specific feedback without
 * risking a state change.
 */
export function validateMove(
  geo: BoardGeometry,
  state: GameState,
  from: number,
  to: number,
): MoveRejection | null {
  if (state.status !== 'playing') return 'not-playing';
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= state.board.length ||
    to >= state.board.length
  ) {
    return 'out-of-bounds';
  }
  if (state.board[from] !== cellStateFor(state.currentPlayer)) return 'not-your-piece';
  if (state.board[to] !== 'empty') return 'destination-not-empty';
  if (classifyMove(geo, state.board, from, to, state.currentPlayer) === null) return 'out-of-range';
  return null;
}

export function isLegalMove(geo: BoardGeometry, state: GameState, from: number, to: number): boolean {
  return validateMove(geo, state, from, to) === null;
}

/**
 * Plays a move and resolves the full turn: conversions, scores, skipped turns
 * and end-of-game detection.
 *
 * @throws {IllegalMoveError} when the move is not legal in `state`.
 */
export function applyMove(geo: BoardGeometry, state: GameState, from: number, to: number): MoveResult {
  const rejection = validateMove(geo, state, from, to);
  if (rejection !== null) {
    throw new IllegalMoveError(rejection, describeRejection(rejection, from, to));
  }

  const player = state.currentPlayer;
  const type = classifyMove(geo, state.board, from, to, player)!;
  const board: CellState[] = [...state.board];
  const converted = getConversions(geo, board, to, player);
  applyMoveToBoard(geo, board, { from, to, type }, player);

  const move: Move = {
    from,
    to,
    type,
    player,
    converted,
    turnNumber: state.turnNumber,
  };

  const scores = computeScores(board);
  const handoff = resolveTurnHandoff(geo, board, player, scores);

  const next: GameState = {
    ...state,
    board,
    scores,
    selectedCell: null,
    lastMove: move,
    turnNumber: state.turnNumber + 1,
    currentPlayer: handoff.nextPlayer,
    skippedPlayers: handoff.skipped,
    status: handoff.gameOver ? 'finished' : 'playing',
    winner: handoff.gameOver ? determineWinner(scores) : null,
  };

  return { state: next, move, skipped: handoff.skipped, gameOver: handoff.gameOver };
}

interface Handoff {
  nextPlayer: PlayerId;
  skipped: PlayerId[];
  gameOver: boolean;
}

/**
 * Decides who moves next after `mover` has played.
 *
 * Order of checks matters:
 *  1. A player reduced to zero pieces can never recover, so the match ends.
 *  2. Otherwise the opponent moves if they can.
 *  3. If they cannot, they are skipped and the mover continues — but only if
 *     the mover still has a move themselves.
 *  4. If nobody can move (which includes a full board), the match ends.
 */
function resolveTurnHandoff(
  geo: BoardGeometry,
  board: readonly CellState[],
  mover: PlayerId,
  scores: { player1: number; player2: number },
): Handoff {
  const other = opponentOf(mover);

  if (scores.player1 === 0 || scores.player2 === 0) {
    return { nextPlayer: other, skipped: [], gameOver: true };
  }

  if (hasLegalMove(geo, board, other)) {
    return { nextPlayer: other, skipped: [], gameOver: false };
  }

  if (hasLegalMove(geo, board, mover)) {
    return { nextPlayer: mover, skipped: [other], gameOver: false };
  }

  return { nextPlayer: other, skipped: [other], gameOver: true };
}

/** True when neither player can move (used by tests and defensive checks). */
export function isGameOver(geo: BoardGeometry, state: GameState): boolean {
  if (state.scores.player1 === 0 || state.scores.player2 === 0) return true;
  return !hasLegalMove(geo, state.board, 1) && !hasLegalMove(geo, state.board, 2);
}

function describeRejection(reason: MoveRejection, from: number, to: number): string {
  switch (reason) {
    case 'not-playing':
      return 'The match is not in play.';
    case 'not-your-piece':
      return `Space ${from} does not hold one of the active player's monsters.`;
    case 'destination-not-empty':
      return `Space ${to} is not empty.`;
    case 'out-of-range':
      return `Space ${to} is not one or two steps from space ${from}.`;
    case 'out-of-bounds':
      return `Move ${from} -> ${to} references a space that is not on the board.`;
  }
}
