/**
 * Serialisation helpers for `GameState`.
 *
 * These exist so an in-progress match survives an orientation change, a tab
 * refresh or a service-worker update. The format is versioned and validated on
 * the way back in — a corrupt or stale save is discarded rather than trusted.
 */

import type { BoardGeometry } from './board.ts';
import { computeScores } from './scoring.ts';
import type { CellState, GameState, Move, MoveType, PlayerId } from './types.ts';

export const SAVE_VERSION = 1;

const CELL_CODES: Record<CellState, string> = {
  empty: '.',
  blocked: '#',
  player1: '1',
  player2: '2',
};

const CODE_TO_CELL: Record<string, CellState> = {
  '.': 'empty',
  '#': 'blocked',
  '1': 'player1',
  '2': 'player2',
};

export interface SerialisedGame {
  v: number;
  boardId: string;
  /** Board encoded one character per space. */
  board: string;
  currentPlayer: PlayerId;
  turnNumber: number;
  status: GameState['status'];
  winner: GameState['winner'];
  lastMove: Move | null;
  skippedPlayers: PlayerId[];
}

export function encodeBoard(board: readonly CellState[]): string {
  return board.map((c) => CELL_CODES[c]).join('');
}

export function decodeBoard(encoded: string): CellState[] | null {
  const out: CellState[] = [];
  for (const ch of encoded) {
    const cell = CODE_TO_CELL[ch];
    if (!cell) return null;
    out.push(cell);
  }
  return out;
}

export function serialiseGame(state: GameState): SerialisedGame {
  return {
    v: SAVE_VERSION,
    boardId: state.boardId,
    board: encodeBoard(state.board),
    currentPlayer: state.currentPlayer,
    turnNumber: state.turnNumber,
    status: state.status === 'paused' ? 'playing' : state.status,
    winner: state.winner,
    lastMove: state.lastMove,
    skippedPlayers: state.skippedPlayers,
  };
}

/**
 * Rebuilds a state from its serialised form.
 * Returns `null` when the payload is malformed or does not match the layout —
 * for example after a board layout is edited in a future release.
 */
export function deserialiseGame(raw: unknown, geo: BoardGeometry): GameState | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Partial<SerialisedGame>;
  if (data.v !== SAVE_VERSION) return null;
  if (data.boardId !== geo.id) return null;
  if (typeof data.board !== 'string') return null;

  const board = decodeBoard(data.board);
  if (!board || board.length !== geo.cells.length) return null;

  // Blocked spaces are a property of the layout, never of the save.
  for (let i = 0; i < board.length; i++) {
    const shouldBeBlocked = geo.cells[i]!.blocked;
    if (shouldBeBlocked !== (board[i] === 'blocked')) return null;
  }

  const currentPlayer: PlayerId = data.currentPlayer === 2 ? 2 : 1;
  const status = data.status === 'finished' ? 'finished' : 'playing';
  const winner =
    data.winner === 1 || data.winner === 2 || data.winner === 'tie' ? data.winner : null;

  return {
    boardId: geo.id,
    board,
    currentPlayer,
    selectedCell: null,
    scores: computeScores(board),
    status,
    winner: status === 'finished' ? winner : null,
    turnNumber: typeof data.turnNumber === 'number' && data.turnNumber > 0 ? data.turnNumber : 1,
    lastMove: sanitiseMove(data.lastMove, board.length),
    skippedPlayers: Array.isArray(data.skippedPlayers)
      ? data.skippedPlayers.filter((p): p is PlayerId => p === 1 || p === 2)
      : [],
  };
}

function sanitiseMove(move: unknown, boardLength: number): Move | null {
  if (!move || typeof move !== 'object') return null;
  const m = move as Partial<Move>;
  const inRange = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < boardLength;
  if (!inRange(m.from) || !inRange(m.to)) return null;
  const type: MoveType = m.type === 'jump' ? 'jump' : 'clone';
  const player: PlayerId = m.player === 2 ? 2 : 1;
  return {
    from: m.from,
    to: m.to,
    type,
    player,
    converted: Array.isArray(m.converted) ? m.converted.filter(inRange) : [],
    turnNumber: typeof m.turnNumber === 'number' ? m.turnNumber : 1,
  };
}
