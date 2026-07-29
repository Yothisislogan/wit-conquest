import { describe, expect, it } from 'vitest';
import { getAllBoards } from '../data/boards.ts';
import { getLegalMoves, hasLegalMove } from './moves.ts';
import { applyMove, createInitialState, IllegalMoveError, isGameOver, validateMove } from './rules.ts';
import { computeScores, countEmpty, determineWinner } from './scoring.ts';
import { indexAt, randomMove, seededRandom, smallBoard, stateFrom } from './test-helpers.ts';
import type { CellState, GameState } from './types.ts';

const geo = smallBoard();

describe('validation', () => {
  it('accepts a legal clone and a legal jump', () => {
    const state = stateFrom(geo, { player1: [{ q: 0, r: 0 }] });
    expect(validateMove(geo, state, indexAt(geo, 0, 0), indexAt(geo, 1, 0))).toBeNull();
    expect(validateMove(geo, state, indexAt(geo, 0, 0), indexAt(geo, 2, 0))).toBeNull();
  });

  it('rejects moving a piece that is not yours', () => {
    const state = stateFrom(geo, { player1: [{ q: 0, r: 0 }], player2: [{ q: 1, r: 0 }] });
    expect(validateMove(geo, state, indexAt(geo, 1, 0), indexAt(geo, 2, 0))).toBe('not-your-piece');
  });

  it('rejects an occupied destination', () => {
    const state = stateFrom(geo, { player1: [{ q: 0, r: 0 }], player2: [{ q: 1, r: 0 }] });
    expect(validateMove(geo, state, indexAt(geo, 0, 0), indexAt(geo, 1, 0))).toBe('destination-not-empty');
  });

  it('rejects a destination three or more steps away', () => {
    const state = stateFrom(geo, { player1: [{ q: -2, r: 0 }] });
    expect(validateMove(geo, state, indexAt(geo, -2, 0), indexAt(geo, 1, 0))).toBe('out-of-range');
  });

  it('rejects out-of-bounds and non-integer indices', () => {
    const state = stateFrom(geo, { player1: [{ q: 0, r: 0 }] });
    expect(validateMove(geo, state, -1, 0)).toBe('out-of-bounds');
    expect(validateMove(geo, state, 0, 10_000)).toBe('out-of-bounds');
    expect(validateMove(geo, state, 0.5, 1)).toBe('out-of-bounds');
  });

  it('rejects any move once the match is finished', () => {
    const state: GameState = { ...stateFrom(geo, { player1: [{ q: 0, r: 0 }] }), status: 'finished' };
    expect(validateMove(geo, state, indexAt(geo, 0, 0), indexAt(geo, 1, 0))).toBe('not-playing');
  });

  it('throws IllegalMoveError rather than mutating on a bad move', () => {
    const state = stateFrom(geo, { player1: [{ q: 0, r: 0 }], player2: [{ q: 1, r: 0 }] });
    const snapshot = [...state.board];
    expect(() => applyMove(geo, state, indexAt(geo, 1, 0), indexAt(geo, 2, 0))).toThrow(IllegalMoveError);
    expect(state.board).toEqual(snapshot);
  });

  it('never mutates the state it was given', () => {
    const state = stateFrom(geo, { player1: [{ q: 0, r: 0 }], player2: [{ q: 0, r: 2 }] });
    const snapshot = [...state.board];
    const result = applyMove(geo, state, indexAt(geo, 0, 0), indexAt(geo, 1, 0));
    expect(state.board).toEqual(snapshot);
    expect(result.state.board).not.toBe(state.board);
  });
});

describe('applying moves', () => {
  it('clones without vacating the source and adds one piece', () => {
    const state = stateFrom(geo, { player1: [{ q: 0, r: 0 }], player2: [{ q: 0, r: 2 }] });
    const result = applyMove(geo, state, indexAt(geo, 0, 0), indexAt(geo, 1, 0));
    expect(result.move.type).toBe('clone');
    expect(result.state.board[indexAt(geo, 0, 0)]).toBe('player1');
    expect(result.state.board[indexAt(geo, 1, 0)]).toBe('player1');
    expect(result.state.scores.player1).toBe(2);
  });

  it('jumps by vacating the source, keeping the piece count level', () => {
    const state = stateFrom(geo, { player1: [{ q: 0, r: 0 }], player2: [{ q: 0, r: 2 }] });
    const result = applyMove(geo, state, indexAt(geo, 0, 0), indexAt(geo, 2, -1));
    expect(result.move.type).toBe('jump');
    expect(result.state.board[indexAt(geo, 0, 0)]).toBe('empty');
    expect(result.state.scores.player1).toBe(1);
  });

  it('converts every enemy touching the landing space', () => {
    const state = stateFrom(geo, {
      player1: [{ q: 0, r: -1 }],
      player2: [
        { q: 1, r: 0 },
        { q: -1, r: 0 },
        { q: 0, r: 1 },
        { q: 2, r: 0 },
      ],
    });
    const result = applyMove(geo, state, indexAt(geo, 0, -1), indexAt(geo, 0, 0));
    expect(result.move.converted).toHaveLength(3);
    expect(result.state.scores).toEqual({ player1: 5, player2: 1 });
    // The distant enemy is untouched.
    expect(result.state.board[indexAt(geo, 2, 0)]).toBe('player2');
  });

  it('records the move on the resulting state and advances the turn counter', () => {
    const state = stateFrom(geo, { player1: [{ q: 0, r: 0 }], player2: [{ q: 0, r: 2 }] });
    const result = applyMove(geo, state, indexAt(geo, 0, 0), indexAt(geo, 1, 0));
    expect(result.state.turnNumber).toBe(2);
    expect(result.state.lastMove).toEqual(result.move);
    expect(result.state.selectedCell).toBeNull();
    expect(result.move.turnNumber).toBe(1);
  });
});

describe('turn handling', () => {
  it('passes the turn to the opponent when they can move', () => {
    const state = stateFrom(geo, { player1: [{ q: 0, r: 0 }], player2: [{ q: 0, r: 2 }] });
    const result = applyMove(geo, state, indexAt(geo, 0, 0), indexAt(geo, 1, 0));
    expect(result.state.currentPlayer).toBe(2);
    expect(result.skipped).toEqual([]);
  });

  it('skips a player with no legal move and lets the mover continue', () => {
    // Player 2 sits in the far corner, hemmed in by player 1 monsters. The only
    // empty spaces left are in the opposite corner, four steps out of reach.
    const board = geo.cells.map(() => 'player1' as CellState);
    board[indexAt(geo, -2, 0)] = 'player2';
    board[indexAt(geo, 2, 0)] = 'empty';
    board[indexAt(geo, 2, -1)] = 'empty';

    const state: GameState = {
      ...createInitialState(geo),
      board,
      currentPlayer: 1,
      scores: computeScores(board),
    };

    expect(hasLegalMove(geo, board, 2)).toBe(false);
    expect(hasLegalMove(geo, board, 1)).toBe(true);

    const result = applyMove(geo, state, indexAt(geo, 1, 0), indexAt(geo, 2, 0));
    expect(result.skipped).toEqual([2]);
    expect(result.state.currentPlayer).toBe(1);
    expect(result.state.skippedPlayers).toEqual([2]);
    expect(result.gameOver).toBe(false);
  });

  it('clears the skip list once a normal hand-off happens', () => {
    const state = stateFrom(geo, { player1: [{ q: 0, r: 0 }], player2: [{ q: 0, r: 2 }] });
    const withSkip: GameState = { ...state, skippedPlayers: [2] };
    const result = applyMove(geo, withSkip, indexAt(geo, 0, 0), indexAt(geo, 1, 0));
    expect(result.state.skippedPlayers).toEqual([]);
  });
});

describe('end of match', () => {
  it('ends immediately when a player is wiped out', () => {
    const state = stateFrom(geo, {
      player1: [{ q: 0, r: -1 }],
      player2: [{ q: 1, r: 0 }],
    });
    const result = applyMove(geo, state, indexAt(geo, 0, -1), indexAt(geo, 0, 0));
    expect(result.state.scores.player2).toBe(0);
    expect(result.gameOver).toBe(true);
    expect(result.state.status).toBe('finished');
    expect(result.state.winner).toBe(1);
  });

  it('ends when the board fills up', () => {
    const board = geo.cells.map((_, index) => (index % 2 === 0 ? 'player1' : 'player2') as CellState);
    const lastEmpty = indexAt(geo, 0, 0);
    board[lastEmpty] = 'empty';
    // Guarantee player 1 has a piece next to the final space.
    board[geo.neighbors[lastEmpty]![0]!] = 'player1';

    const state: GameState = {
      ...createInitialState(geo),
      board,
      currentPlayer: 1,
      scores: computeScores(board),
    };
    const result = applyMove(geo, state, geo.neighbors[lastEmpty]![0]!, lastEmpty);
    expect(countEmpty(result.state.board)).toBe(0);
    expect(result.gameOver).toBe(true);
    expect(result.state.status).toBe('finished');
  });

  it('supports a tie', () => {
    expect(determineWinner({ player1: 7, player2: 7 })).toBe('tie');
    expect(determineWinner({ player1: 8, player2: 7 })).toBe(1);
    expect(determineWinner({ player1: 7, player2: 8 })).toBe(2);
  });

  it('reports game over when neither side can move', () => {
    const board = geo.cells.map((_, index) => (index % 2 === 0 ? 'player1' : 'player2') as CellState);
    const state: GameState = {
      ...createInitialState(geo),
      board,
      scores: computeScores(board),
    };
    expect(isGameOver(geo, state)).toBe(true);
  });
});

describe('shipped layouts play to completion', () => {
  it('always finishes, keeps scores equal to the piece count, and never plays an illegal move', () => {
    for (const layout of getAllBoards()) {
      for (let seed = 1; seed <= 12; seed++) {
        const rng = seededRandom(seed * 7919 + layout.id.length);
        let state = createInitialState(layout);
        let guard = 0;

        while (state.status === 'playing') {
          if (guard++ > 8_000) throw new Error(`${layout.id} did not terminate`);

          const legal = getLegalMoves(layout, state.board, state.currentPlayer);
          expect(legal.length, `${layout.id}: current player must always have a move`).toBeGreaterThan(0);

          const move = randomMove(layout, state.board, state.currentPlayer, rng)!;
          const result = applyMove(layout, state, move.from, move.to);
          state = result.state;

          // The invariant the whole UI depends on.
          expect(state.scores).toEqual(computeScores(state.board));
        }

        expect(state.status).toBe('finished');
        expect(state.winner).toBe(determineWinner(state.scores));

        const stuck =
          state.scores.player1 === 0 ||
          state.scores.player2 === 0 ||
          (!hasLegalMove(layout, state.board, 1) && !hasLegalMove(layout, state.board, 2));
        expect(stuck, `${layout.id}: match ended for a valid reason`).toBe(true);
      }
    }
  });

  it('starts every layout with mirrored scores and a full complement of empty spaces', () => {
    for (const layout of getAllBoards()) {
      const state = createInitialState(layout);
      expect(state.scores.player1).toBe(state.scores.player2);
      expect(state.currentPlayer).toBe(1);
      expect(state.status).toBe('playing');
      expect(state.turnNumber).toBe(1);
      expect(state.scores.player1 + state.scores.player2 + countEmpty(state.board)).toBe(
        layout.playableCount,
      );
    }
  });

  it('produces the mirror-image position when both players mirror each other', () => {
    // On a 180-degree symmetric board, player 2 answering with the rotated copy
    // of player 1's move must reproduce a perfectly balanced position.
    for (const layout of getAllBoards()) {
      let state = createInitialState(layout);
      const first = getLegalMoves(layout, state.board, 1)[0]!;
      state = applyMove(layout, state, first.from, first.to).state;

      const mirrorIndex = (index: number): number => {
        const cell = layout.cells[index]!;
        const found = layout.cells.find((c) => c.q === -cell.q && c.r === -cell.r);
        if (!found) throw new Error(`no mirror for ${cell.id}`);
        return found.index;
      };

      const reply = { from: mirrorIndex(first.from), to: mirrorIndex(first.to) };
      expect(validateMove(layout, state, reply.from, reply.to)).toBeNull();
      state = applyMove(layout, state, reply.from, reply.to).state;
      expect(state.scores.player1).toBe(state.scores.player2);
    }
  });
});

describe('board loading', () => {
  it('lays out three distinct, balanced, fully reachable layouts', () => {
    const boards = getAllBoards();
    expect(boards).toHaveLength(3);
    expect(new Set(boards.map((b) => b.id)).size).toBe(3);
    for (const board of boards) {
      expect(board.playableCount).toBeGreaterThanOrEqual(45);
      expect(board.playableCount).toBeLessThanOrEqual(65);
      expect(board.cells).toHaveLength(61);
    }
    // The layouts must actually differ from one another.
    const signatures = boards.map((b) => b.initialBoard.join(''));
    expect(new Set(signatures).size).toBe(3);
  });
});
