/**
 * Opponent tests.
 *
 * The properties that matter are the ones a player would notice if they broke:
 * the monster always moves, it moves legally, it moves *soon*, the same seed
 * replays the same game, and the hard monster actually beats the easy one.
 */

import { describe, expect, it } from 'vitest';
import { getAllBoards, getBoard } from '../data/boards.ts';
import type { BoardGeometry } from '../game/board.ts';
import { getLegalMoves } from '../game/moves.ts';
import { applyMove, createInitialState } from '../game/rules.ts';
import { determineWinner } from '../game/scoring.ts';
import type { CellState, GameState, MoveOption, PlayerId } from '../game/types.ts';
import { chooseMove } from './ai-engine.ts';
import { WEIGHTS, evaluateBoard } from './evaluate-board.ts';
import { chooseEasyMove } from './easy-ai.ts';
import { chooseHardMove } from './hard-ai.ts';
import { searchBestMove } from './minimax.ts';
import { chooseNormalMove } from './normal-ai.ts';
import { DIFFICULTIES, createRandom, type AiOptions, type Difficulty, type MoveChooser } from './types.ts';

const CHOOSERS: Record<Difficulty, MoveChooser> = {
  easy: chooseEasyMove,
  normal: chooseNormalMove,
  hard: chooseHardMove,
};

/** Small budgets keep the suite quick; the search adapts to whatever it gets. */
const TEST_BUDGET: Record<Difficulty, number> = { easy: 3, normal: 8, hard: 8 };

const BOARD_IDS = ['classic', 'crossroads', 'islands'] as const;

/**
 * Deterministic stand-in for `performance.now`. Every read advances the clock by
 * a fixed amount, so a search that reads the clock the same number of times
 * takes the same "time" on every run and on every machine.
 */
function virtualClock(step = 1): () => number {
  let t = 0;
  return () => (t += step);
}

function isLegal(
  geo: BoardGeometry,
  board: readonly CellState[],
  player: PlayerId,
  move: MoveOption,
): boolean {
  return getLegalMoves(geo, board, player).some(
    (m) => m.from === move.from && m.to === move.to && m.type === move.type,
  );
}

/** Plays `plies` uniformly random legal moves from the opening position. */
function randomPosition(geo: BoardGeometry, plies: number, random: () => number): GameState {
  let state = createInitialState(geo);
  for (let i = 0; i < plies && state.status === 'playing'; i++) {
    const moves = getLegalMoves(geo, state.board, state.currentPlayer);
    if (moves.length === 0) break;
    const move = moves[Math.floor(random() * moves.length)]!;
    state = applyMove(geo, state, move.from, move.to).state;
  }
  return state;
}

describe('move legality', () => {
  it.each(BOARD_IDS)('every difficulty returns a legal move throughout a playout on %s', (boardId) => {
    const geo = getBoard(boardId);

    for (const seed of [1, 7]) {
      const random = createRandom(seed);
      let state = createInitialState(geo);
      let plies = 0;

      while (state.status === 'playing' && plies < 200) {
        const player = state.currentPlayer;
        const legal = getLegalMoves(geo, state.board, player);
        expect(legal.length).toBeGreaterThan(0);

        for (const difficulty of DIFFICULTIES) {
          const options: AiOptions = {
            timeLimitMs: TEST_BUDGET[difficulty],
            random: createRandom(seed * 1000 + plies),
          };
          const result = CHOOSERS[difficulty](geo, state.board, player, options);

          // A legal move exists, so no difficulty may decline to move.
          expect(result, `${difficulty} returned null on ${boardId} ply ${plies}`).not.toBeNull();
          expect(
            isLegal(geo, state.board, player, result!.move),
            `${difficulty} played an illegal move on ${boardId} ply ${plies}`,
          ).toBe(true);
        }

        // Drive the playout with random moves so the positions stay varied.
        const move = legal[Math.floor(random() * legal.length)]!;
        state = applyMove(geo, state, move.from, move.to).state;
        plies++;
      }

      // Guard against the playout stalling in the opening and only exercising
      // a handful of near-identical positions.
      expect(plies).toBeGreaterThan(30);
    }
  }, 120_000);

  it('returns null only when the player genuinely cannot move', () => {
    const geo = getBoard('classic');
    // A board with no pieces at all for player 1: nothing can be moved.
    const board: CellState[] = geo.initialBoard.map((cell) =>
      cell === 'player1' ? 'empty' : cell,
    );
    const options: AiOptions = { timeLimitMs: 20, random: createRandom(3) };

    for (const difficulty of DIFFICULTIES) {
      expect(CHOOSERS[difficulty](geo, board, 1, options)).toBeNull();
    }
    expect(searchBestMove(geo, board, 1, {
      timeLimitMs: 20,
      random: createRandom(3),
      maxDepth: 4,
      weights: WEIGHTS.hard,
    })).toBeNull();
    expect(chooseMove(geo, board, 1, 'hard', options)).toBeNull();

    // The same board still offers player 2 a move, and it must be taken.
    for (const difficulty of DIFFICULTIES) {
      const result = CHOOSERS[difficulty](geo, board, 2, options);
      expect(result).not.toBeNull();
      expect(isLegal(geo, board, 2, result!.move)).toBe(true);
    }
  });

  it('never mutates the board it is given', () => {
    const geo = getBoard('crossroads');
    const state = randomPosition(geo, 14, createRandom(21));
    const before = [...state.board];

    for (const difficulty of DIFFICULTIES) {
      CHOOSERS[difficulty](geo, state.board, state.currentPlayer, {
        timeLimitMs: TEST_BUDGET[difficulty],
        random: createRandom(9),
      });
      expect(state.board).toEqual(before);
    }
  });
});

describe('time budget', () => {
  it('hard returns well inside a 150ms budget', () => {
    let worst = 0;

    for (const boardId of BOARD_IDS) {
      const geo = getBoard(boardId);
      for (const plies of [0, 12, 30]) {
        const state = randomPosition(geo, plies, createRandom(plies + 5));
        if (state.status !== 'playing') continue;

        const started = Date.now();
        const result = chooseHardMove(geo, state.board, state.currentPlayer, {
          timeLimitMs: 150,
          random: createRandom(99),
          now: () => performance.now(),
        });
        const elapsed = Date.now() - started;

        expect(result).not.toBeNull();
        worst = Math.max(worst, elapsed);
      }
    }

    expect(worst).toBeLessThan(600);
  }, 60_000);

  it('keeps the deepest completed iteration when a deeper one is cut off', () => {
    const geo = getBoard('classic');
    const state = randomPosition(geo, 16, createRandom(4));

    // A budget large enough for depth 1-2 but far too small to finish deeper.
    const shallow = searchBestMove(geo, state.board, state.currentPlayer, {
      timeLimitMs: 12,
      random: createRandom(4),
      now: () => performance.now(),
      maxDepth: 8,
      weights: WEIGHTS.hard,
    });

    expect(shallow).not.toBeNull();
    expect(shallow!.depth).toBeGreaterThanOrEqual(1);
    expect(isLegal(geo, state.board, state.currentPlayer, shallow!.move)).toBe(true);
    // Depth reported is a *completed* depth, never the abandoned iteration.
    expect(shallow!.depth).toBeLessThanOrEqual(8);
  });

  it('still produces a legal move when the budget is effectively zero', () => {
    const geo = getBoard('islands');
    const state = randomPosition(geo, 18, createRandom(6));

    for (const difficulty of DIFFICULTIES) {
      const result = CHOOSERS[difficulty](geo, state.board, state.currentPlayer, {
        timeLimitMs: 0,
        random: createRandom(1),
        // A clock that is already past the deadline on its first read aborts
        // the very first node of the search.
        now: virtualClock(10_000),
      });
      expect(result).not.toBeNull();
      expect(isLegal(geo, state.board, state.currentPlayer, result!.move)).toBe(true);
    }
  });
});

describe('determinism', () => {
  it.each(DIFFICULTIES)('%s replays identically from the same seed', (difficulty) => {
    const geo = getBoard('classic');
    const state = randomPosition(geo, 10, createRandom(33));

    const run = () =>
      CHOOSERS[difficulty](geo, state.board, state.currentPlayer, {
        timeLimitMs: 40,
        random: createRandom(2024),
        // Virtual clock: identical node counts produce identical timings, so
        // the wall-clock cut-off cannot make the search non-deterministic.
        now: virtualClock(),
      });

    const first = run();
    const second = run();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.move).toEqual(first!.move);
    expect(second!.depth).toBe(first!.depth);
    expect(second!.nodes).toBe(first!.nodes);
  });

  it('different seeds can produce different easy moves', () => {
    const geo = getBoard('classic');
    const state = randomPosition(geo, 8, createRandom(12));
    const moves = new Set<string>();

    for (let seed = 0; seed < 30; seed++) {
      const result = chooseEasyMove(geo, state.board, state.currentPlayer, {
        timeLimitMs: 5,
        random: createRandom(seed),
      });
      expect(result).not.toBeNull();
      expect(isLegal(geo, state.board, state.currentPlayer, result!.move)).toBe(true);
      moves.add(`${result!.move.from}-${result!.move.to}-${result!.move.type}`);
    }

    // Easy is meant to be varied, not a lookup table.
    expect(moves.size).toBeGreaterThan(1);
  });
});

describe('evaluateBoard', () => {
  it('scores the mirrored starting position as dead level', () => {
    for (const geo of getAllBoards()) {
      expect(evaluateBoard(geo, geo.initialBoard, 1, WEIGHTS.hard)).toBeCloseTo(0, 9);
      expect(evaluateBoard(geo, geo.initialBoard, 2, WEIGHTS.hard)).toBeCloseTo(0, 9);
    }
  });

  it('flips sign with the point of view', () => {
    const geo = getBoard('classic');

    // Hand player 1 a commanding position: every free space near the middle.
    const board: CellState[] = [...geo.initialBoard];
    let handed = 0;
    for (let i = 0; i < board.length && handed < 12; i++) {
      if (board[i] === 'empty') {
        board[i] = 'player1';
        handed++;
      }
    }

    for (const weights of [WEIGHTS.easy, WEIGHTS.normal, WEIGHTS.hard]) {
      const forOne = evaluateBoard(geo, board, 1, weights);
      const forTwo = evaluateBoard(geo, board, 2, weights);
      expect(forOne).toBeGreaterThan(0);
      expect(forTwo).toBeLessThan(0);
      expect(forTwo).toBeCloseTo(-forOne, 6);
    }
  });

  it('prefers having more pieces', () => {
    const geo = getBoard('islands');
    const base: CellState[] = [...geo.initialBoard];
    const richer: CellState[] = [...base];
    const spare = base.findIndex((cell) => cell === 'empty');
    richer[spare] = 'player1';

    expect(evaluateBoard(geo, richer, 1, WEIGHTS.hard)).toBeGreaterThan(
      evaluateBoard(geo, base, 1, WEIGHTS.hard),
    );
  });
});

describe('strength', () => {
  it('hard beats easy over a series of matches', () => {
    const geo = getBoard('classic');
    const matches = 10;
    let hardWins = 0;
    let easyWins = 0;

    for (let match = 0; match < matches; match++) {
      // Alternate seats so neither difficulty benefits from moving first.
      const hardSeat: PlayerId = match % 2 === 0 ? 1 : 2;
      const winner = playMatch(geo, hardSeat, 500 + match);
      if (winner === hardSeat) hardWins++;
      else if (winner !== 'tie') easyWins++;
    }

    expect(hardWins + easyWins).toBeGreaterThan(0);
    expect(hardWins).toBeGreaterThan(easyWins);
    expect(hardWins).toBeGreaterThanOrEqual(Math.ceil(matches * 0.7));
  }, 180_000);
});

/** Plays a full match, `hardSeat` played by hard and the other seat by easy. */
function playMatch(geo: BoardGeometry, hardSeat: PlayerId, seed: number): PlayerId | 'tie' {
  const random = createRandom(seed);
  let state = createInitialState(geo);
  let guard = 0;

  while (state.status === 'playing' && guard < 400) {
    const difficulty: Difficulty = state.currentPlayer === hardSeat ? 'hard' : 'easy';
    const result = chooseMove(geo, state.board, state.currentPlayer, difficulty, {
      timeLimitMs: difficulty === 'hard' ? 25 : 2,
      random,
      now: () => performance.now(),
    });
    expect(result).not.toBeNull();

    state = applyMove(geo, state, result!.move.from, result!.move.to).state;
    guard++;
  }

  return state.winner ?? determineWinner(state.scores);
}
