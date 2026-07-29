/**
 * Score keeping. Scores are always a straight count of pieces on the board —
 * there is no end-of-game fill rule — so the number shown in the status bar can
 * always be verified by counting monsters.
 */

import type { CellState, PlayerId, Scores } from './types.ts';

export function computeScores(board: readonly CellState[]): Scores {
  let player1 = 0;
  let player2 = 0;
  for (const cell of board) {
    if (cell === 'player1') player1++;
    else if (cell === 'player2') player2++;
  }
  return { player1, player2 };
}

export function scoreFor(scores: Scores, player: PlayerId): number {
  return player === 1 ? scores.player1 : scores.player2;
}

export function countEmpty(board: readonly CellState[]): number {
  let empty = 0;
  for (const cell of board) if (cell === 'empty') empty++;
  return empty;
}

/** Winner by piece count, or `'tie'` when the counts are equal. */
export function determineWinner(scores: Scores): PlayerId | 'tie' {
  if (scores.player1 > scores.player2) return 1;
  if (scores.player2 > scores.player1) return 2;
  return 'tie';
}
