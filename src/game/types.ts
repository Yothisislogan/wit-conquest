/**
 * Shared value types for the Monster Territory rules engine.
 *
 * Nothing in this file may import from `src/ui` or touch the DOM: the engine is
 * deliberately renderer-agnostic so it can run inside a Web Worker, in Node for
 * unit tests, and in the browser from the same source.
 */

export type PlayerId = 1 | 2;

export type CellState = 'empty' | 'blocked' | 'player1' | 'player2';

export type MoveType = 'clone' | 'jump';

export type GameStatus = 'menu' | 'playing' | 'paused' | 'finished';

/** Axial hex coordinate. See `hex.ts` for the coordinate system contract. */
export interface Axial {
  q: number;
  r: number;
}

/** A single space on a compiled board. */
export interface HexCell {
  /** Stable `"q,r"` key. */
  id: string;
  /** Index into `GameState.board`. */
  index: number;
  q: number;
  r: number;
  /** 1-based offset coordinates, used only for human-readable labels. */
  row: number;
  col: number;
  /** Pre-computed centre in board units (see `BoardGeometry.hexSize`). */
  x: number;
  y: number;
  /** True when the space can never hold a piece. */
  blocked: boolean;
}

export interface Move {
  /** Index of the player's own piece that initiated the move. */
  from: number;
  /** Index of the destination space. */
  to: number;
  type: MoveType;
  player: PlayerId;
  /** Indices of opponent pieces flipped by this move. */
  converted: number[];
  /** 1-based turn counter at the time the move was played. */
  turnNumber: number;
}

/** A move without its resolved side effects — what move generators return. */
export interface MoveOption {
  from: number;
  to: number;
  type: MoveType;
}

export interface Scores {
  player1: number;
  player2: number;
}

export interface GameState {
  /** Id of the board layout this state was created from. */
  boardId: string;
  board: CellState[];
  currentPlayer: PlayerId;
  selectedCell: number | null;
  scores: Scores;
  status: GameStatus;
  winner: PlayerId | 'tie' | null;
  turnNumber: number;
  lastMove: Move | null;
  /**
   * Players skipped since the last successful move. Cleared whenever a move is
   * played, so the UI can announce "Blue has no legal moves" exactly once.
   */
  skippedPlayers: PlayerId[];
}

export function opponentOf(player: PlayerId): PlayerId {
  return player === 1 ? 2 : 1;
}

export function cellStateFor(player: PlayerId): CellState {
  return player === 1 ? 'player1' : 'player2';
}

export function playerOfCell(state: CellState): PlayerId | null {
  if (state === 'player1') return 1;
  if (state === 'player2') return 2;
  return null;
}
