import { describe, expect, it } from 'vitest';
import { getAllBoards } from '../data/boards.ts';
import { computeScores, countEmpty, determineWinner, scoreFor } from './scoring.ts';
import { applyMove, createInitialState } from './rules.ts';
import { randomMove, seededRandom } from './test-helpers.ts';
import type { CellState } from './types.ts';

describe('scoring', () => {
  it('counts only monsters, never blocked or empty spaces', () => {
    const board: CellState[] = ['player1', 'player1', 'player2', 'empty', 'blocked', 'blocked'];
    expect(computeScores(board)).toEqual({ player1: 2, player2: 1 });
    expect(countEmpty(board)).toBe(1);
  });

  it('reads a single player score', () => {
    const scores = { player1: 12, player2: 7 };
    expect(scoreFor(scores, 1)).toBe(12);
    expect(scoreFor(scores, 2)).toBe(7);
  });

  it('handles an empty board', () => {
    expect(computeScores([])).toEqual({ player1: 0, player2: 0 });
    expect(determineWinner({ player1: 0, player2: 0 })).toBe('tie');
  });

  it('keeps score in lockstep with the board through a whole match', () => {
    for (const layout of getAllBoards()) {
      const rng = seededRandom(4242 + layout.playableCount);
      let state = createInitialState(layout);
      let guard = 0;

      while (state.status === 'playing' && guard++ < 8_000) {
        const move = randomMove(layout, state.board, state.currentPlayer, rng);
        if (!move) break;
        state = applyMove(layout, state, move.from, move.to).state;

        const counted = computeScores(state.board);
        expect(state.scores).toEqual(counted);
        expect(state.scores.player1 + state.scores.player2 + countEmpty(state.board)).toBe(
          layout.playableCount,
        );
      }
    }
  });

  it('never lets a clone reduce the mover’s score, nor a jump change it before conversions', () => {
    for (const layout of getAllBoards()) {
      const rng = seededRandom(99);
      let state = createInitialState(layout);

      for (let i = 0; i < 60 && state.status === 'playing'; i++) {
        const move = randomMove(layout, state.board, state.currentPlayer, rng);
        if (!move) break;
        const before = state.scores;
        const mover = state.currentPlayer;
        const result = applyMove(layout, state, move.from, move.to);
        const after = result.state.scores;

        const gained = mover === 1 ? after.player1 - before.player1 : after.player2 - before.player2;
        const expected = (move.type === 'clone' ? 1 : 0) + result.move.converted.length;
        expect(gained).toBe(expected);

        const lost = mover === 1 ? before.player2 - after.player2 : before.player1 - after.player1;
        expect(lost).toBe(result.move.converted.length);

        state = result.state;
      }
    }
  });
});
