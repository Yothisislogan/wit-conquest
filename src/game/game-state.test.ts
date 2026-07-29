import { describe, expect, it } from 'vitest';
import { getAllBoards, getBoard } from '../data/boards.ts';
import { decodeBoard, deserialiseGame, encodeBoard, SAVE_VERSION, serialiseGame } from './game-state.ts';
import { applyMove, createInitialState } from './rules.ts';
import { randomMove, seededRandom } from './test-helpers.ts';

describe('board encoding', () => {
  it('round-trips every cell state', () => {
    const board = ['empty', 'blocked', 'player1', 'player2'] as const;
    expect(decodeBoard(encodeBoard([...board]))).toEqual([...board]);
  });

  it('refuses an unknown character', () => {
    expect(decodeBoard('..x..')).toBeNull();
  });
});

describe('save round-trip', () => {
  it('restores an in-progress match exactly', () => {
    for (const layout of getAllBoards()) {
      const rng = seededRandom(31 + layout.playableCount);
      let state = createInitialState(layout);
      for (let i = 0; i < 12 && state.status === 'playing'; i++) {
        const move = randomMove(layout, state.board, state.currentPlayer, rng);
        if (!move) break;
        state = applyMove(layout, state, move.from, move.to).state;
      }

      const restored = deserialiseGame(serialiseGame(state), layout);
      expect(restored).not.toBeNull();
      expect(restored!.board).toEqual(state.board);
      expect(restored!.currentPlayer).toBe(state.currentPlayer);
      expect(restored!.turnNumber).toBe(state.turnNumber);
      expect(restored!.scores).toEqual(state.scores);
      expect(restored!.lastMove).toEqual(state.lastMove);
      // A restored match never comes back with a stale selection.
      expect(restored!.selectedCell).toBeNull();
    }
  });

  it('treats a paused match as playable when reloaded', () => {
    const geo = getBoard('classic');
    const state = { ...createInitialState(geo), status: 'paused' as const };
    expect(serialiseGame(state).status).toBe('playing');
  });

  it('discards a save from another layout', () => {
    const classic = getBoard('classic');
    const islands = getBoard('islands');
    const payload = serialiseGame(createInitialState(classic));
    expect(deserialiseGame(payload, islands)).toBeNull();
  });

  it('discards a save with the wrong version', () => {
    const geo = getBoard('classic');
    const payload = { ...serialiseGame(createInitialState(geo)), v: SAVE_VERSION + 1 };
    expect(deserialiseGame(payload, geo)).toBeNull();
  });

  it('discards a save whose obstacles no longer match the layout', () => {
    const geo = getBoard('crossroads');
    const payload = serialiseGame(createInitialState(geo));
    // Someone edited the save to un-block a space.
    const tampered = { ...payload, board: payload.board.replace('#', '.') };
    expect(deserialiseGame(tampered, geo)).toBeNull();
  });

  it('discards garbage instead of throwing', () => {
    const geo = getBoard('classic');
    for (const junk of [null, undefined, 42, 'nope', {}, { v: SAVE_VERSION }, []]) {
      expect(deserialiseGame(junk, geo)).toBeNull();
    }
  });

  it('discards a save of the wrong length', () => {
    const geo = getBoard('classic');
    const payload = serialiseGame(createInitialState(geo));
    expect(deserialiseGame({ ...payload, board: payload.board.slice(0, -1) }, geo)).toBeNull();
  });

  it('sanitises a corrupted lastMove rather than trusting it', () => {
    const geo = getBoard('classic');
    const payload = serialiseGame(createInitialState(geo));
    const restored = deserialiseGame(
      { ...payload, lastMove: { from: -5, to: 99999, type: 'teleport', player: 7, converted: 'x' } },
      geo,
    );
    expect(restored).not.toBeNull();
    expect(restored!.lastMove).toBeNull();
  });

  it('recomputes scores from the board rather than trusting the payload', () => {
    const geo = getBoard('classic');
    const payload = serialiseGame(createInitialState(geo));
    const restored = deserialiseGame({ ...payload, scores: { player1: 999, player2: 0 } }, geo)!;
    expect(restored.scores).toEqual({ player1: 3, player2: 3 });
  });
});
